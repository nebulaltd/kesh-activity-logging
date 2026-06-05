# Pull-based activity log ingestion design

## Status
Accepted

## Date
2026-06-02

## Context
`kesh-activity-logging` cannot reliably receive pushed logs from `kesh-back` because network access to the logger service is restricted by IP allowlisting. `kesh-back` is reachable from the logger side, so log transfer should be inverted: the logger service periodically pulls buffered logs from `kesh-back`.

Current systems:
- `kesh-activity-logging`: Bun + Fastify + SQLite. Existing API stores logs via `POST /logs` and queries them via `GET /logs`.
- `kesh-back`: NestJS + TypeORM + PostgreSQL. No durable structured logging layer exists yet. Cron support already exists through `@nestjs/schedule`.

## Decision
Use a durable PostgreSQL outbox in `kesh-back` and a one-minute polling job in `kesh-activity-logging`.

`kesh-back` stores outbound activity log events in an `activity_log_outbox` table. `kesh-activity-logging` calls an internal API on `kesh-back`, inserts received events into SQLite, then acknowledges the inserted IDs. `kesh-back` marks acknowledged rows as delivered.

## API contract

### `GET /internal/activity-logs?limit=500`

Auth: `x-internal-api-key: <shared secret>`.

Returns oldest undelivered events first:

```json
{
  "items": [
    {
      "id": "outbox-id",
      "timestamp": 1730000000000,
      "source": "kesh-back",
      "level": "info",
      "message": "procurement approved",
      "context": {},
      "trace_id": null,
      "user_id": "42",
      "entity_type": "Procurement",
      "entity_id": "123",
      "action": "approved",
      "client_id": "tenant-A"
    }
  ]
}
```

### `POST /internal/activity-logs/ack`

Auth: `x-internal-api-key: <shared secret>`.

Request:

```json
{ "ids": ["outbox-id"] }
```

Effect: mark matching undelivered rows as delivered with `delivered_at = now()`.

## Data model

`kesh-back` table: `activity_log_outbox`

Fields:
- `id` primary key
- `timestamp` bigint, Unix ms
- `source` varchar
- `level` enum-compatible varchar: `debug | info | warn | error | fatal`
- `message` text
- `context` jsonb nullable
- `trace_id`, `user_id`, `entity_type`, `entity_id`, `action`, `client_id` nullable varchar
- `delivered_at` nullable timestamp
- `delivery_attempts` integer default 0
- `created_at`, `updated_at`, `deleted_at` via `BasicEntity`

Index undelivered reads by `(delivered_at, created_at, id)`.

## Logger polling behavior

Every minute:
1. Fetch up to `LOG_PULL_BATCH_SIZE` events.
2. Validate each event against the existing log input schema plus outbox `id`.
3. Insert each event into SQLite.
4. ACK only successfully inserted event IDs.
5. Leave failed events unacknowledged for retry.

The logger owns final storage; `kesh-back` outbox is temporary delivery state.

## Error handling

- Missing/invalid internal key: `401`.
- Invalid query/body: `400` or existing Nest validation response.
- Insert failure in logger: do not ACK that ID.
- ACK failure: events may be redelivered; logger must deduplicate by outbox ID or tolerate duplicate delivery safely.

## Alternatives considered

### File buffer
Rejected. Simpler but weaker concurrency, harder ACK semantics, and easier to corrupt during deploy/restart.

### Direct logger connection to `kesh-back` PostgreSQL
Rejected. Leaks DB credentials across services and couples logger to `kesh-back` schema.

### Keep push-based ingestion
Rejected for this environment because network allowlisting blocks direct access from `kesh-back` to logger.

## Open implementation choices

- Whether logger stores `external_id`/`source_event_id` for exact deduplication or uses deterministic log IDs from outbox IDs.
- Whether `kesh-back` captures logs manually through a service first, or later adds interceptors for mutating requests.
