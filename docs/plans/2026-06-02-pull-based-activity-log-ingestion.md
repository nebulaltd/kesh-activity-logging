# Pull-Based Activity Log Ingestion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build pull-based delivery where `kesh-back` buffers activity logs in PostgreSQL and `kesh-activity-logging` polls, stores, and acknowledges them.

**Architecture:** `kesh-back` owns a durable outbox table plus internal authenticated fetch/ack endpoints. `kesh-activity-logging` owns final SQLite storage and runs a one-minute poller that fetches undelivered events, validates them, inserts them, and ACKs only successful inserts.

**Tech Stack:** NestJS 8, TypeORM 0.2, PostgreSQL, Bun, Fastify, SQLite, zod, `bun test`, Jest.

---

## Task 1: Add kesh-back outbox entity and migration

**Files:**
- Create: `/Users/ermanddurro/Code/Kesh/kesh-back/src/entities/activity-log-outbox.entity.ts`
- Create: `/Users/ermanddurro/Code/Kesh/kesh-back/src/migrations/1780440000000-createActivityLogOutboxTable.ts`

**Step 1: Write the entity**

Create `ActivityLogOutbox` extending `BasicEntity` with columns: `id`, `timestamp`, `source`, `level`, `message`, `context`, `traceId`, `userId`, `entityType`, `entityId`, `action`, `clientId`, `deliveredAt`, `deliveryAttempts`.

Use DB column names `trace_id`, `user_id`, `entity_type`, `entity_id`, `client_id`, `delivered_at`, `delivery_attempts`.

**Step 2: Write migration**

Create table `activity_log_outbox` with matching columns, JSONB `context`, nullable delivery fields, and index on `(delivered_at, created_at, id)`.

**Step 3: Verify build**

Run in `/Users/ermanddurro/Code/Kesh/kesh-back`:

```bash
npm run build
```

Expected: TypeScript build succeeds.

---

## Task 2: Add kesh-back internal activity log module

**Files:**
- Create: `/Users/ermanddurro/Code/Kesh/kesh-back/src/app-api/activity-log/activity-log.module.ts`
- Create: `/Users/ermanddurro/Code/Kesh/kesh-back/src/app-api/activity-log/activity-log.service.ts`
- Create: `/Users/ermanddurro/Code/Kesh/kesh-back/src/app-api/activity-log/activity-log-internal.controller.ts`
- Create: `/Users/ermanddurro/Code/Kesh/kesh-back/src/app-api/activity-log/dto/ack-activity-logs.dto.ts`
- Modify: `/Users/ermanddurro/Code/Kesh/kesh-back/src/app-api/app-api.module.ts`

**Step 1: Write service tests if test harness supports module testing**

Cover:
- fetch returns oldest undelivered rows first
- limit capped to 1000
- ack only marks requested undelivered rows delivered

If no service test harness exists, write controller/service code first and verify through e2e/manual curl later.

**Step 2: Implement service**

Methods:
- `findUndelivered(limit: number)` increments `deliveryAttempts` for returned rows and returns DTOs matching logger schema plus outbox `id`.
- `ack(ids: string[])` sets `deliveredAt = new Date()` where IDs match and `deliveredAt IS NULL`.

**Step 3: Implement controller**

Routes:
- `GET /internal/activity-logs?limit=500`
- `POST /internal/activity-logs/ack`

Auth:
- Require `x-internal-api-key` equals `process.env.ACTIVITY_LOG_INTERNAL_API_KEY`.
- Return `401` if missing/mismatched.
- Do not use JWT guards; this is server-to-server auth.

**Step 4: Register module**

Import `ActivityLogModule` into `AppApiModule`.

**Step 5: Verify build**

Run:

```bash
npm run build
```

Expected: build succeeds.

---

## Task 3: Add kesh-back outbox writer API

**Files:**
- Modify: `/Users/ermanddurro/Code/Kesh/kesh-back/src/app-api/activity-log/activity-log.service.ts`

**Step 1: Add `record()` method**

Input fields match logger `InsertLogSchema`: `timestamp`, `source`, `level`, `message`, `context`, `trace_id`, `user_id`, `entity_type`, `entity_id`, `action`, `client_id`.

Default:
- `timestamp = Date.now()`
- `source = 'kesh-back'`
- `level = 'info'`

**Step 2: Add first usage point**

Record one low-risk event, e.g. successful login/logout or procurement status change, depending on product priority.

**Step 3: Verify build**

Run:

```bash
npm run build
```

Expected: build succeeds.

---

## Task 4: Add logger pull config

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `test/config.test.ts` or existing closest config test if present

**Step 1: Add failing tests**

Test defaults:
- pull disabled when `LOG_PULL_SOURCE_URL` missing
- batch size defaults to `500`
- interval defaults to `60000`

Test validation:
- requires `LOG_PULL_API_KEY` when `LOG_PULL_SOURCE_URL` is set

**Step 2: Add config fields**

Add:
- `LOG_PULL_SOURCE_URL?: string`
- `LOG_PULL_API_KEY?: string`
- `LOG_PULL_INTERVAL_MS: number = 60000`
- `LOG_PULL_BATCH_SIZE: number = 500`

**Step 3: Run targeted tests**

Run:

```bash
bun test test/config.test.ts
```

Expected: pass.

---

## Task 5: Add logger pull client and poller

**Files:**
- Create: `src/logs/pullClient.ts`
- Create: `src/logs/poller.ts`
- Modify: `src/index.ts`
- Test: `test/logs.pull.test.ts`

**Step 1: Write failing tests**

Cover:
- fetch sends `x-internal-api-key`
- invalid remote payload is rejected before insert
- ACK is sent only for successfully inserted rows
- no ACK on fetch failure

**Step 2: Implement client**

Functions:
- `fetchRemoteLogs(config): Promise<RemoteLog[]>`
- `ackRemoteLogs(config, ids: string[]): Promise<void>`

Use `fetch`; validate response with zod.

**Step 3: Implement poller**

Function:
- `startLogPuller({ db, config, logger }): () => void`

Behavior:
- If no `LOG_PULL_SOURCE_URL`, return no-op stop function.
- Run once on startup, then every interval.
- Prevent overlapping runs.
- Insert each valid log into SQLite.
- ACK only inserted remote IDs.

**Step 4: Wire startup**

In `src/index.ts`, start poller after DB migration/app startup setup. Ensure stop function is called on shutdown if shutdown handling exists.

**Step 5: Run targeted tests**

Run:

```bash
bun test test/logs.pull.test.ts
```

Expected: pass.

---

## Task 6: Add deduplication for pulled logs

**Files:**
- Create: `src/db/migrations/0003_remote_log_dedup.sql`
- Modify: `src/logs/repository.ts`
- Modify: `src/logs/types.ts`
- Test: `test/logs.pull.test.ts`

**Step 1: Write failing test**

Given the same remote outbox ID is fetched twice, logger stores one log and ACKs without creating duplicate rows.

**Step 2: Add schema**

Add nullable columns:
- `remote_source TEXT`
- `remote_id TEXT`

Add unique index on `(remote_source, remote_id)` where both are not null.

**Step 3: Update insert path**

Allow pulled inserts to set `remote_source = 'kesh-back'` and `remote_id = outbox id`. Duplicate remote rows should be treated as already stored and still ACKable.

**Step 4: Run migration test and pull test**

Run:

```bash
bun test test/db.migrate.test.ts test/logs.pull.test.ts
```

Expected: pass.

---

## Task 7: Deployment configuration

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Step 1: Document kesh-back env**

Add:

```env
ACTIVITY_LOG_INTERNAL_API_KEY=shared-secret
```

**Step 2: Document logger env**

Add:

```env
LOG_PULL_SOURCE_URL=https://kesh-back-domain/internal/activity-logs
LOG_PULL_API_KEY=shared-secret
LOG_PULL_INTERVAL_MS=60000
LOG_PULL_BATCH_SIZE=500
```

**Step 3: Document Forge cron note**

The logger does not need Forge cron; the Bun process owns the interval. Forge only manages the background process.

---

## Task 8: End-to-end manual verification

**Step 1: Deploy kesh-back**

Run build and migrations through Forge deploy.

**Step 2: Insert a test outbox row**

Use a low-risk admin-only path or a temporary DB insert in production only if approved.

**Step 3: Deploy logger**

Set logger env vars and deploy.

**Step 4: Verify local logger DB**

Call:

```bash
curl -i https://kesh-activity-logging.on-forge.com/logs \
  -H "x-api-key: LOGGER_API_KEY" \
  --resolve kesh-activity-logging.on-forge.com:443:46.252.37.171
```

Expected: pulled log appears.

**Step 5: Verify kesh-back ACK**

Confirm `delivered_at` is non-null for the outbox row.
