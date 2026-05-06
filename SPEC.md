# SPEC — Kesh Activity Logging API

> **Revision 2026-05-06**: Added activity-log fields (`entity_type`, `entity_id`, `action`, `client_id`) as nullable first-class columns + filters, after determining kesh-back's audit-trail use case requires structured filtering. Migration `0002_activity_fields.sql`. Existing logs unaffected (all new columns nullable).
>
> **Revision 2026-05-05b**: Swapped `better-sqlite3` → `bun:sqlite` (Bun built-in) after native build failed on dev machine due to Python 3.14 / libexpat ABI issue. Test runner consequently swapped Vitest → `bun test` since Vitest workers can't load `bun:sqlite`. API surface and SPEC behaviors unchanged.

## 1. Objective

HTTP API that ingests structured log events from other systems, persists them in SQLite, and exposes filtered retrieval. Single-process, single-file DB, deployable as a Docker container. No UI, no alerting, no shipping agents — just the API.

**Target users:** internal services that need a central place to record activity/audit/debug events and operators who query them.

**Success criteria:**
- Ingest 1k events/sec on a modest box without dropping writes (WAL mode, prepared statements).
- p95 read latency < 50ms for filtered queries over 10M rows with proper indexes.
- Zero data loss across process restarts (durable SQLite + fsync on commit).

## 2. Commands

Package manager + runtime: **Bun**.

| Command | Purpose |
|---|---|
| `bun install` | Install deps |
| `bun run dev` | Start Fastify in watch mode |
| `bun run start` | Start production server |
| `bun run build` | Type-check + emit (if needed for Docker) |
| `bun run test` | Run `bun test` suite |
| `bun run test:watch` | `bun test --watch` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun run format` | Prettier write |
| `bun run db:migrate` | Apply migrations to configured DB file |

## 3. Project Structure

```
.
├── src/
│   ├── server.ts              # Fastify app factory (exported for tests)
│   ├── index.ts               # Entrypoint: build + listen
│   ├── config.ts              # Env parsing + validation (zod)
│   ├── db/
│   │   ├── client.ts          # bun:sqlite Database instance, WAL pragmas
│   │   ├── migrations/        # Numbered .sql files (0001_init.sql, ...)
│   │   └── migrate.ts         # Migration runner
│   ├── auth/
│   │   └── apiKey.ts          # X-API-Key Fastify hook
│   ├── logs/
│   │   ├── routes.ts          # POST /logs, GET /logs, GET /logs/:id
│   │   ├── repository.ts      # All SQL lives here (insert, query, getById)
│   │   ├── schema.ts          # zod request/response schemas
│   │   └── types.ts
│   └── lib/
│       ├── errors.ts          # Typed errors + Fastify error handler
│       └── id.ts              # ULID/UUID generation
├── test/
│   ├── logs.ingest.test.ts
│   ├── logs.query.test.ts
│   ├── auth.test.ts
│   └── helpers/buildApp.ts    # In-memory SQLite app for tests
├── Dockerfile
├── docker-compose.yml         # Optional, for local dev
├── package.json
├── tsconfig.json
├── .env.example
└── SPEC.md
```

## 4. Data Model

Single table `logs`:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | ULID, generated server-side |
| `timestamp` | INTEGER NOT NULL | Unix ms; client-supplied or server-default |
| `source` | TEXT NOT NULL | e.g. `billing-api`, `auth-worker`, `kesh-back` |
| `level` | TEXT NOT NULL CHECK | One of `debug|info|warn|error|fatal` |
| `message` | TEXT NOT NULL | Free-form |
| `context` | TEXT NULL | JSON blob (validated as object) |
| `trace_id` | TEXT NULL | Propagated correlation id |
| `user_id` | TEXT NULL | Actor id, if relevant |
| `entity_type` | TEXT NULL | Domain entity, e.g. `Procurement`, `Offer`, `Invoice` |
| `entity_id` | TEXT NULL | Entity primary key (string — supports numeric or UUID) |
| `action` | TEXT NULL | Verb, e.g. `created`, `approved`, `cancelled` |
| `client_id` | TEXT NULL | Multi-tenant slice |
| `received_at` | INTEGER NOT NULL | Server insert time, Unix ms |

Indexes:
- `(timestamp DESC)` — default ordering
- `(source, timestamp DESC)` — per-service queries
- `(level, timestamp DESC)` — error sweeps
- `(trace_id)` — correlation lookup
- `(entity_type, entity_id, timestamp DESC)` — "show all activity on Procurement #42"
- `(client_id, timestamp DESC)` — tenant-scoped views
- `(action, timestamp DESC)` — verb-scoped views

## 5. HTTP API

All routes require header `X-API-Key: <key>` except `GET /health`.

### `POST /logs`
Body (JSON):
```json
{
  "timestamp": 1730000000000,
  "source": "kesh-back",
  "level": "info",
  "message": "procurement approved",
  "context": { "status_before": "draft", "status_after": "approved" },
  "trace_id": "abc-123",
  "user_id": "u_42",
  "entity_type": "Procurement",
  "entity_id": "42",
  "action": "approved",
  "client_id": "tenant-A"
}
```
- `timestamp` optional → defaults to server now.
- `context` optional, must be a JSON object if present.
- All activity fields (`entity_type`, `entity_id`, `action`, `client_id`) are optional.
- Returns `201 { "id": "<ulid>" }`.

### `GET /logs`
Query params: `source`, `level`, `from` (ms), `to` (ms), `trace_id`, `user_id`, `entity_type`, `entity_id`, `action`, `client_id`, `q` (literal substring on `message`), `cursor`, `limit` (default 100, max 1000). All filters combine with AND.
Returns:
```json
{ "items": [ /* log rows */ ], "next_cursor": "..." | null }
```
Cursor = opaque base64 of `(timestamp, id)` for keyset pagination, ordered `timestamp DESC, id DESC`.

### `GET /logs/:id`
Returns single row or `404`.

### `GET /health`
`200 { "status": "ok" }`. No auth.

### Errors
JSON: `{ "error": { "code": "...", "message": "..." } }`. Codes: `unauthorized`, `validation_error`, `not_found`, `internal`.

## 6. Configuration

Env vars (validated with zod at boot, fail fast):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `DATABASE_PATH` | `./data/logs.db` | Created if missing |
| `API_KEY` | — | Required, non-empty |
| `LOG_LEVEL` | `info` | Fastify logger level |
| `BODY_LIMIT_BYTES` | `1048576` | 1MB default |

`.env.example` committed; real `.env` gitignored.

## 7. Code Style

- TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess: true`).
- ESM only.
- Prettier defaults; ESLint with `@typescript-eslint` recommended + `import/order`.
- Naming: `camelCase` vars/functions, `PascalCase` types, `SCREAMING_SNAKE` env vars, `snake_case` SQL columns.
- All SQL lives in `repository.ts` files — routes never see SQL strings.
- Validation at the edge with zod; internal code trusts parsed types.
- No console.log — use Fastify's logger.
- Errors: throw typed `AppError` subclasses; one Fastify error handler maps to HTTP.
- Be concise; no speculative abstractions, no comments stating the obvious.

## 8. Testing Strategy

- **Framework:** `bun test` (Bun's built-in runner — Vitest-compatible API: `describe`/`it`/`expect`).
- **Style:** integration tests over unit tests. Each test boots a Fastify app against a fresh in-memory SQLite (`:memory:`) with migrations applied.
- **Coverage targets** (informal): every route has happy-path + auth-failure + validation-failure tests.
- **Required suites:**
  - `auth.test.ts` — missing/wrong/correct key.
  - `logs.ingest.test.ts` — valid insert, defaults applied, validation errors, body too large.
  - `logs.query.test.ts` — filter by each param, pagination cursor stability, `GET /logs/:id` 200/404.
  - `migrations.test.ts` — fresh DB → schema matches expected.
- **No mocking the DB.** Real SQLite, every time.
- CI runs `bun run typecheck && bun run lint && bun run test`.
- Test files live in `test/` and are matched by `bun test`'s default `*.test.ts` glob.

## 9. Boundaries

### Always
- Run all writes inside a prepared statement.
- Enable SQLite pragmas at startup: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- Validate every request body and query string with zod before touching the DB.
- Use keyset pagination, never `OFFSET`.
- Return ULIDs, never expose internal rowids.
- Log every request at `info`, every error at `error`, with `trace_id` if present.

### Ask first
- Adding a new endpoint or query parameter not listed above.
- Adding a dependency beyond: `fastify`, `zod`, `ulid` (runtime); `typescript`, `eslint`, `prettier`, `@types/*` (dev). SQLite is the built-in `bun:sqlite`, no package needed. Test runner is the built-in `bun test`, no package needed.
- Schema changes after the first migration ships — must be a new numbered migration, never edit existing ones.
- Anything that changes the auth model.

### Never
- Run raw SQL outside `repository.ts`.
- Use `OFFSET` pagination.
- Return stack traces or internal error details to clients.
- Auto-delete or mutate log rows (immutable append-only store; no retention job in v1).
- Introduce a UI, alerting, queue, or cache layer in this repo.
- Skip migrations or hand-edit the DB schema.
- Use `npm` or `pnpm` — Bun only.

## 10. Out of Scope (v1)

- No batch ingest endpoint.
- No retention / TTL.
- No UI or dashboard.
- No alerting, webhooks, or fan-out.
- No multi-tenancy beyond a single shared API key.
- No streaming/tail endpoint (SSE/WebSocket).
- No aggregation/stats endpoint.

## 11. Open Questions

None — all clarified in spec session 2026-05-05.
