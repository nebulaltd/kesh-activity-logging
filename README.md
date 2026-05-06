# kesh-activity-logging

HTTP API that captures structured log events from other systems, stores them in SQLite, and exposes filtered retrieval. See [SPEC.md](SPEC.md) for the contract.

## Stack

Bun + TypeScript + Fastify + `bun:sqlite` + zod. Test runner: `bun test`.

## Local development

```bash
bun install
cp .env.example .env          # set API_KEY
bun run db:migrate            # apply migrations to ./data/logs.db
bun run dev                   # watch mode on http://localhost:3000
```

## Verify

```bash
bun run typecheck
bun run lint
bun run test
```

## API

Base URL: `http://localhost:3000`. All endpoints except `GET /health` require the header `x-api-key: $API_KEY`. Request and response bodies are JSON.

Errors always look like:

```json
{ "error": { "code": "unauthorized" | "validation_error" | "not_found" | "internal", "message": "..." } }
```

### `GET /health`

Liveness probe. No auth.

```bash
curl -s localhost:3000/health
# → {"status":"ok"}
```

### `POST /logs` — store a log

Required fields: `source`, `level`, `message`.
Optional: `timestamp` (Unix ms; defaults to server time), `context` (JSON object), `trace_id`, `user_id`, and the **activity fields** below. Unknown fields are rejected.

`level` must be one of: `debug`, `info`, `warn`, `error`, `fatal`.

**Activity fields** — use these when logging audit-trail events so they can be filtered as first-class columns rather than being buried in `context`:

| Field | Example | Meaning |
|---|---|---|
| `entity_type` | `"Procurement"` | The domain entity acted on |
| `entity_id` | `"42"` | Its primary key (always a string) |
| `action` | `"approved"` | The verb performed (use a stable vocabulary) |
| `client_id` | `"tenant-A"` | Which tenant/customer this belongs to |

Activity log example:

```bash
curl -s -X POST localhost:3000/logs \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "source": "kesh-back",
    "level": "info",
    "message": "procurement approved",
    "entity_type": "Procurement",
    "entity_id": "42",
    "action": "approved",
    "client_id": "tenant-A",
    "user_id": "u_42",
    "trace_id": "req-abc-123",
    "context": { "status_before": "draft", "status_after": "approved" }
  }'
# → 201 {"id":"01KQY5H0ARKFZF0GTVCTDQXGK0"}
```

Operational log example (no activity context):

```bash
curl -s -X POST localhost:3000/logs \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"source":"worker","level":"warn","message":"retrying job"}'
```

Bodies above the configured `BODY_LIMIT_BYTES` (default 1 MB) are rejected with `413`.

### `GET /logs/:id` — fetch one

```bash
curl -s "localhost:3000/logs/01KQY5H0ARKFZF0GTVCTDQXGK0" \
  -H "x-api-key: $API_KEY"
```

Response:

```json
{
  "id": "01KQY5H0ARKFZF0GTVCTDQXGK0",
  "timestamp": 1730000000000,
  "source": "kesh-back",
  "level": "info",
  "message": "procurement approved",
  "context": { "status_before": "draft", "status_after": "approved" },
  "trace_id": "req-abc-123",
  "user_id": "u_42",
  "entity_type": "Procurement",
  "entity_id": "42",
  "action": "approved",
  "client_id": "tenant-A",
  "received_at": 1730000000123
}
```

Activity fields are `null` for logs that didn't supply them. Unknown id → `404 {"error":{"code":"not_found", ...}}`.

### `GET /logs` — query with filters

All query parameters are optional and combine with AND. Results are returned in descending timestamp order.

| Param | Notes |
|---|---|
| `source` | exact match |
| `level` | exact match (`debug`/`info`/`warn`/`error`/`fatal`) |
| `from` | Unix ms, inclusive lower bound on `timestamp` |
| `to` | Unix ms, inclusive upper bound on `timestamp` |
| `trace_id` | exact match |
| `user_id` | exact match |
| `entity_type` | exact match (e.g. `Procurement`) |
| `entity_id` | exact match — usually paired with `entity_type` |
| `action` | exact match (e.g. `approved`) |
| `client_id` | exact match (multi-tenant slice) |
| `q` | literal substring match on `message` (no wildcards) |
| `limit` | default `100`, max `1000` |
| `cursor` | opaque, returned as `next_cursor` from a previous page |

```bash
# Operational: all errors from one service in the last hour
NOW=$(date +%s)000
HOUR_AGO=$(( NOW - 3600000 ))
curl -s "localhost:3000/logs?source=kesh-back&level=error&from=$HOUR_AGO&to=$NOW" \
  -H "x-api-key: $API_KEY"

# Activity: full audit trail for one procurement
curl -s "localhost:3000/logs?entity_type=Procurement&entity_id=42" \
  -H "x-api-key: $API_KEY"

# Activity: every approval across the system this week
curl -s "localhost:3000/logs?action=approved&from=$(( NOW - 604800000 ))" \
  -H "x-api-key: $API_KEY"

# Activity: everything one tenant did
curl -s "localhost:3000/logs?client_id=tenant-A&limit=200" \
  -H "x-api-key: $API_KEY"

# Activity: one user's actions on offers
curl -s "localhost:3000/logs?user_id=u_42&entity_type=Offer" \
  -H "x-api-key: $API_KEY"

# Correlation: every log from one request
curl -s "localhost:3000/logs?trace_id=req-abc-123" -H "x-api-key: $API_KEY"

# Substring search on the message body
curl -s "localhost:3000/logs?q=timeout&limit=20" -H "x-api-key: $API_KEY"
```

Response:

```json
{
  "items": [ { "id": "...", "timestamp": ..., "...": "..." }, ... ],
  "next_cursor": "eyJ0IjoxNzMw..." | null
}
```

`next_cursor` is `null` when the last page has been returned. Otherwise pass it back as `cursor` to fetch the next page:

```bash
PAGE1=$(curl -s "localhost:3000/logs?limit=100" -H "x-api-key: $API_KEY")
CURSOR=$(echo "$PAGE1" | jq -r '.next_cursor')
[ "$CURSOR" != "null" ] && \
  curl -s "localhost:3000/logs?limit=100&cursor=$CURSOR" -H "x-api-key: $API_KEY"
```

Cursors are stable: rows inserted with newer timestamps after a page is fetched will not appear in subsequent pages of that walk.

## Docker

```bash
docker build -t kesh-logs .
docker run --rm -p 3000:3000 \
  -e API_KEY=your-secret \
  -v "$(pwd)/data:/app/data" \
  kesh-logs
```

Or via compose:

```bash
API_KEY=your-secret docker compose up --build
```

The DB lives at `/app/data/logs.db` inside the container; mount a host volume to persist across restarts.
