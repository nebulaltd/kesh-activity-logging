# Scheduled Activity Log Pull Implementation Plan

**Goal:** archive `kesh-back` activity logs on the on-prem `kesh-activity-logging` instance using a cron-invoked one-shot pull over an SSH tunnel. No changes to `kesh-back`.

**Design:** [2026-07-29-scheduled-activity-log-pull-design.md](2026-07-29-scheduled-activity-log-pull-design.md)

**Stack:** Bun + TypeScript + zod + `bun:sqlite`, bash for the ops wrappers.

---

## Task 1: Pull mode and indexed sources in config

`src/config.ts`

- Add `LOG_PULL_MODE` (`off` | `interval` | `oneshot`, default `off`), `LOG_PULL_MAX_ITERATIONS` (default 20), `LOG_PULL_HEARTBEAT_URL`.
- Export `LogPullSource { name, url, apiKey }` and add `LOG_PULL_SOURCES` to `Config`.
- Resolve sources by scanning env for `LOG_PULL_SOURCE_<n>_URL`, sorted by index; fall back to the `LOG_PULL_SOURCE_URL` / `LOG_PULL_API_KEY` shorthand as a source named `default`.
- Fail with the offending variable named: missing `_API_KEY`, invalid `_URL`, duplicate names, or an enabled mode with no source.

**Status:** done. Covered by `test/config.test.ts`.

---

## Task 2: Per-source drain loop in the poller

`src/logs/poller.ts`

- `fetchRemoteLogs(source, batchSize, fetchFn)` and `ackRemoteLogs(source, ids, fetchFn)` take a source instead of the whole config; errors name the source.
- Add `drainSource`, looping until a partial batch arrives or `maxIterations` is reached; set `hitIterationCap` when the cap stops it.
- Store `remote_source: source.name`.
- `pullLogsOnce` drains every configured source, continues past a failing source, and rethrows the first error after all sources have been attempted. Returns `PullRunResult` with per-source counts and `durationMs`.
- `startLogPuller` requires `LOG_PULL_MODE === 'interval'`.

**Status:** done. Covered by `test/logs.pull.test.ts` and `test/logs.pullOnce.test.ts`.

---

## Task 3: One-shot CLI

`src/logs/pull-once.ts`, `package.json`

- `assertOneshotMode` refuses to run unless `LOG_PULL_MODE === 'oneshot'`.
- Ensure the data directory, open the DB, run migrations, drain, write a heartbeat row, print the JSON summary to stdout, exit 0.
- On failure: print the message to stderr, write an `action: pull_run_failed` row, exit 1.
- Ping `LOG_PULL_HEARTBEAT_URL` after success; a failed ping is logged, never fatal.
- Add `bun run pull:once`.

**Status:** done.

---

## Task 4: Pull wrapper script

`scripts/pull-activity-logs.sh`

- Single-run lock via `mkdir`; a concurrent run logs a warning and exits 0.
- Source the env file with globbing disabled; resolve `bun` from `BUN_BIN`, then `PATH`, then known install locations, with an explicit error when it cannot be found.
- Open the SSH tunnel when `PULL_SSH_HOST` is set, wait for the local port to accept connections, and tear it down in an `EXIT` trap.
- Log to `logs/activity-log-pull.log`, rotate above 10 MB, prune rotations older than `PULL_LOG_RETENTION_DAYS`.
- On failure, send an alert email via `mail` or `sendmail`, and say plainly when `PULL_ALERT_EMAIL` is unset.
- `pull-activity-logs.sh tunnel-test` verifies connectivity without pulling.

**Status:** done.

---

## Task 5: Cron installer

`scripts/install-cron.sh`

- `install` renders `LOG_PULL_CRON_SCHEDULE` into a crontab entry tagged `# kesh-activity-logging:pull`, preserving all other entries; re-running replaces the tagged entry.
- Read the schedule by parsing the env file rather than sourcing it, so a multi-word value works quoted or not.
- Reject a schedule that is not 5 fields, with a hint about quoting.
- Materialise the new crontab to a temp file before calling `crontab`, so the read of the current crontab cannot race the write.
- `remove` and `show` operate on the same marker; removing when nothing is installed succeeds.

**Status:** done.

---

## Task 6: Configuration and documentation

`.env.example`, `README.md`

- Document every `LOG_PULL_*` and `PULL_*` variable, the mode gate, and the quoting requirement for `LOG_PULL_CRON_SCHEDULE`.
- README section covering on-prem setup, tunnel test, cron install, and how to read the heartbeat rows.

**Status:** done.

---

## Task 7: Verification

Automated:

```bash
bun test          # 79 tests
bun run typecheck
bun run lint      # requires Node >= 18
```

Manual smoke test against a stub outbox, all confirmed:

| Scenario | Expectation | Result |
| --- | --- | --- |
| 7 rows, batch 3 | 3 batches, 7 inserted, exit 0 | pass |
| Re-run after full ack | 0 fetched, exit 0 | pass |
| Batch 3, cap 2 | 6 inserted, `hit_iteration_cap`, heartbeat `warn`, exit 0 | pass |
| Source down | exit 1, `pull_run_failed` row, alert path fires, lock released | pass |
| Wrong API key | exit 1, error names the source and status 401 | pass |
| Lock held | warns, exits 0, does not pull | pass |
| Cron install | entry added, other entries preserved, idempotent | pass |
| Cron remove | tagged entry gone, others intact; no-op when absent | pass |
| 3-field schedule | refuses with a quoting hint | pass |

Remaining manual step, once infrastructure values are known:

```bash
scripts/pull-activity-logs.sh tunnel-test
scripts/install-cron.sh install
scripts/install-cron.sh show
```

Then confirm rows arrive:

```bash
curl -s "localhost:3000/logs?source=kesh-back&limit=5" -H "x-api-key: $API_KEY"
curl -s "localhost:3000/logs?action=pull_run&limit=3" -H "x-api-key: $API_KEY"
```
