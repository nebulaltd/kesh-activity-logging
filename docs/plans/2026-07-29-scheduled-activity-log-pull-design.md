# Scheduled activity log pull design

## Status

Accepted

## Date

2026-07-29

## Context

`kesh-back` runs in two places: an AWS deployment serving live traffic, and an on-prem standby running the same `main` branch. Both write activity events to their own `activity_log_outbox` table in PostgreSQL.

Audit events must be archived on a system separate from the application that produced them. The on-prem `kesh-activity-logging` instance is that archive.

The existing puller (`startLogPuller`) is an in-process `setInterval` inside the always-on Bun service. It works, but it presumes a long-lived network path to `kesh-back`, and its failures are visible only as repeated `app.log.error` lines.

Constraints discovered while designing this:

- **The outbox is single-consumer.** `findUndelivered` returns rows where `delivered_at IS NULL`; `ack` stamps `delivered_at`. Consumers compete for rows rather than each receiving a copy. Two pullers pointed at one `kesh-back` split the stream between them.
- **`pullLogsOnce` fetched exactly one batch per call.** Throughput was capped at `LOG_PULL_BATCH_SIZE / interval`. Moving to a less frequent cron schedule without a drain loop would have *lowered* the ceiling.
- **`/internal/activity-logs` is protected only by a static header secret** (`ACTIVITY_LOG_INTERNAL_API_KEY`) and is not behind the app's JWT guards. Its payload is the full audit trail, and its `ack` endpoint lets a caller mark rows delivered. It must not be reachable from the internet.
- Re-pulling is already safe: `insertRemoteLog` is `INSERT OR IGNORE` against `UNIQUE (remote_source, remote_id)`, so a crash between insert and ack costs nothing.

## Decision

Add a cron-invoked one-shot pull to `kesh-activity-logging`. `kesh-back` is not modified.

1. **On-prem is the only consumer** of any `kesh-back` outbox. No second archive, no SIEM tap, until the outbox gains per-consumer cursors.
2. **Transport is an SSH tunnel** opened by the pull script and closed when it exits. `/internal/*` stays private. Each run rebuilds the tunnel, so a dead tunnel self-heals instead of requiring `autossh` supervision.
3. **`LOG_PULL_MODE` gates who pulls**: `off` (default) never pulls, `interval` is the in-process poller, `oneshot` is the cron CLI. The always-on server and the cron job read the same `.env`, so without this gate configuring the cron source would silently re-enable the in-process poller and produce a second consumer.
4. **Multi-source by design.** Sources are configured as an indexed list. `remote_source` stores the configured source *name* (`aws-live`, `onprem`) rather than the literal `'kesh-back'`, which makes provenance queryable and dedupe per-origin. After a failover the on-prem outbox is drained by the same run, with no human in the loop.
5. **Drain loop with a cap.** Each source is pulled until a partial batch arrives or `LOG_PULL_MAX_ITERATIONS` batches have been fetched. Hitting the cap is a backlog signal, not an error.
6. **Retention on `kesh-back` is deliberately unsolved.** Acked rows are never deleted, so the outbox grows. In exchange, the re-pull escape hatch never expires: if the archive is lost, `UPDATE activity_log_outbox SET delivered_at = NULL` for the window and re-run.

## Configuration contract

| Variable | Meaning |
| --- | --- |
| `LOG_PULL_MODE` | `off` \| `interval` \| `oneshot`. Default `off`. |
| `LOG_PULL_SOURCE_<n>_NAME` | Source name, stored as `remote_source`. Defaults to `source-<n>`. |
| `LOG_PULL_SOURCE_<n>_URL` | Outbox URL for that source. |
| `LOG_PULL_SOURCE_<n>_API_KEY` | Must equal `ACTIVITY_LOG_INTERNAL_API_KEY` on that `kesh-back`. |
| `LOG_PULL_SOURCE_URL` / `LOG_PULL_API_KEY` | Single-source shorthand, resolves to a source named `default`. Ignored when indexed sources exist. |
| `LOG_PULL_BATCH_SIZE` | Rows per request, max 1000. |
| `LOG_PULL_MAX_ITERATIONS` | Batches per source per run. Default 20. |
| `LOG_PULL_INTERVAL_MS` | Only meaningful in `interval` mode. |
| `LOG_PULL_CRON_SCHEDULE` | Crontab expression rendered by `install-cron.sh`. |
| `LOG_PULL_HEARTBEAT_URL` | Optional dead-man switch, pinged after a successful run. |
| `PULL_SSH_*` | Tunnel parameters. Empty `PULL_SSH_HOST` means direct access. |
| `PULL_ALERT_EMAIL` | Failure alert recipient. Empty disables alerting, and the script says so. |
| `BUN_BIN` | Absolute path to `bun`; cron does not inherit an interactive `PATH`. |

Indexed sources are parsed by scanning for `LOG_PULL_SOURCE_<n>_URL`, sorted by index. A missing `_API_KEY`, an unparseable `_URL`, or a duplicate name is a startup error naming the offending variable.

## Observability

Three failure modes need three signals:

| Failure | Signal |
| --- | --- |
| Run fails (tunnel down, 401, unreachable) | Non-zero exit, `ERROR` log line, alert email, and an `action: pull_run_failed` row in the archive |
| Run succeeds but cannot keep up | `action: pull_run` row with `level: warn` and `hit_iteration_cap: true` |
| Runs stop entirely | Staleness of the newest `pull_run` row, or the optional heartbeat ping |

Heartbeat rows are written to the local archive, never back into `kesh-back`'s outbox — a pipeline must not report its own health through the pipeline it is reporting on.

## Alternatives considered

### Per-consumer cursors in `kesh-back`

Replace `delivered_at` with `activity_log_consumers(consumer_id, last_seen_id)` and an `?after=` parameter so every consumer sees every row. Technically the better design and the right move the day a second sink exists. Rejected for now: it needs a migration and a new endpoint contract in a module that just shipped, for a second consumer that does not exist yet.

### Replicate `activity_log_outbox` through the existing DB sync

`scripts/run-sync.sh` in `kesh-back` already mirrors PostgreSQL to on-prem. Rejected: it is a full-table mirror for standby, so a failed-over on-prem app would re-emit rows already acked on AWS, and two writers would own one logical stream.

### Always-on process with a persistent tunnel

Keep `setInterval` and supervise the tunnel with `autossh`/systemd. Rejected: the tunnel needs its own liveness management, and a dead tunnel degrades to a log line every 60s that buries real errors.

### systemd timer instead of cron

Better on the merits — journald logging, `OnFailure=`, `RandomizedDelaySec`, no `PATH` surprises. Deferred to keep one operational idiom with `run-sync.sh`, which the team already runs and debugs.

### Copy the SQLite file to a second instance

Rejected: copying a live SQLite database without `VACUUM INTO` is a corruption trap, and it puts the second copy two hops behind.

## Open items

- AWS bastion host, user, key path, and the internal `host:port` that forwards to live `kesh-back:5050`.
- Whether on-prem has outbound HTTPS; decides if `LOG_PULL_HEARTBEAT_URL` is usable.
- Failure-alert recipient and whether `mail` or `sendmail` is available on the box.
- Retention on `kesh-back` — revisit when outbox size becomes material.
