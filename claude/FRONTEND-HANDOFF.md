# Project handoff — current state

Snapshot for a fresh agent picking this up. Backend and a minimal frontend are
both built. This file has the full context; the design rationale is in
[`HLD.md`](./HLD.md) and [`LLD.md`](./LLD.md).

Historically this file was the "build the frontend" brief. The frontend is now
done — section 3 (the API contract) is still current and is referenced from
`README.md` and `web/src/api.ts`, so its numbering is kept.

**Status: backend and frontend are both fully implemented.** Nothing here is a
"build it" task. Reading this file plus `HLD.md` and `LLD.md` is enough to get
the full picture — start here, use the HLD/LLD only for the "why".

### What a next agent would actually do

Pick from, depending on what's asked:
- **Run the e2e suite** (§7) — it has never executed. Bring up
  `docker-compose.test.yml`, run `npm run test:e2e`, fix anything that fails,
  un-skip scenario 8 once Redis-down is wired.
- **Manual walkthrough / demo video** — `docker compose up --build`, seed, then
  click through the four scenarios (open seats, last seat, duplicate, payment
  fail) and the "fire concurrent bookings" button.
- **Close the known gaps** in §7 (e.g. `Retry-After` on 503, the
  `TX_TIMEOUT_MS` vs `BOOKING_TX_TIMEOUT_MS` doc/code mismatch).
- **Polish** the frontend or add scenarios — but the brief caps frontend effort,
  so check before investing.

### Re-seeding

Seed is idempotent (all `upsert` by fixed id):
- `npm run db:seed` — re-apply the seed onto the current DB any time.
- `npm run db:reset` — `prisma migrate reset --force`, drops + re-migrates +
  re-seeds (clean slate).
- e2e tests reseed themselves between cases (`test/helpers/reset-db.ts`:
  `TRUNCATE ... CASCADE` then `seed()`), so you don't seed manually for them.

---

## 1. What's built and verified

Checked this session (run through **PowerShell** — on this machine the Bash tool
has no `node` on PATH):

| Check | Result |
|---|---|
| `npm test` (unit) | 54 passing, 11 suites |
| `npx nest build` | exit 0 |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npx oxlint src/ test/` | clean |
| `cd web && npm run build` | exit 0 (bundles to `web/dist/`) |

**Backend** (`src/`) — complete. Three domain modules (`parents`,
`trial-classes`, `bookings`) plus `common/` infra: config (Joi-validated),
Prisma, Redis, `AppLogger`, global exception filter, global request-logging
interceptor, route-scoped idempotency interceptor. Health check at `GET /health`.

**Frontend** (`web/`) — built. Vite + React 18, no router / UI / state libs, its
own `package.json` and lockfile. `web/src/App.tsx` has four views (parent → review
→ result → roster) toggled by a `view` state var; `web/src/api.ts` is the typed
client with an `ApiError` class and `formatPrice` (via `Intl.NumberFormat`).
Includes the HLD §12 demo affordances: a `success`/`fail` payment toggle and a
"Fire concurrent bookings (demo)" button that books the parent's children into
one class at once so the race resolution is visible.

**Docs / tooling**
- `README.md` — rewritten in a plainer voice; has an API-endpoints table and the
  `web/` workflow.
- `AI-usage.md` at the repo root (consolidated; `claude/AI_USAGE.md` was merged in
  and deleted).
- `postman/trial-booking.postman_collection.json` — health, parents (incl. 404 /
  422), trial-classes (incl. bad-uuid 400), bookings (confirmed, payment_failed,
  duplicate, class-full, missing-key), and a 4-step idempotency-replay flow.

**Change made this session:** added `"exclude": ["node_modules", "dist",
"coverage", "web"]` to `tsconfig.json`. Without it a bare `tsc` walked into
`web/*.tsx` and errored (the web app has its own tsconfig). `nest build`
(tsconfig.build.json, `include: ["src"]`) and Jest were unaffected either way.

---

## 2. Stack (installed versions — do not "upgrade" without a reason)

| Package | Version | Note |
|---|---|---|
| NestJS (`common`/`core`/`platform-express`/`testing`) | 11 | Nest 12 is ESM-only and breaks the Jest/ts-jest setup. 11 is CJS. |
| `@nestjs/config` | 4 | |
| Prisma / `@prisma/client` | 5.22 | Prisma 7 removed `url` from `schema.prisma`. |
| ioredis | 5 | |
| joi | 17 | |
| class-validator / class-transformer | 0.14 / 0.5 | |
| Jest / ts-jest | 30 / 29 | |
| TypeScript | 5.9 (root), 5.7 (`web/`) | |
| Node | 22 local; `node:20-alpine` in Dockerfiles | |

The LLD header still says "NestJS 10 / Prisma 5 / Jest 29 / Node 20" — treat the
table above as the source of truth for what's actually installed.

---

## 3. API contract (base `http://localhost:3000`)

**CORS:** outside `NODE_ENV=production` the API reflects any origin
(`origin: true` in `main.ts`), so a UI on any port, curl, or Postman can call it
directly. Production locks to `CORS_ORIGIN`.

Every 4xx/5xx shares one envelope:
```json
{ "error": "<CODE>", "message": "<user-facing string>", "requestId": "<uuid>" }
```

### `GET /health`
→ `200 { "status": "ok" }`

### `POST /parents/lookup`  — identify step, not auth (HLD §4)
Body `{ "email": "alice@example.com" }` (server trims + lowercases).
- `200 { parentId, name, children: [{ id, name, grade: string|null }] }`
- `404 NOT_FOUND` if the email isn't seeded (creates nothing, verifies nothing)
- `422 VALIDATION_ERROR` if it isn't a valid email
- `@HttpCode(200)` — success is 200, not 201.

### `GET /trial-classes`
→ `200 [{ id, subject, startsAt: ISO8601, capacity, seatsLeft, priceCents }]`
- future classes only (`starts_at > now()`), ordered by `startsAt`
- `seatsLeft` is live (`capacity - confirmed`), never negative — disable a class
  in the UI when it's 0
- `priceCents` is minor units under one implied currency; format at the edge

### `GET /trial-classes/:id/roster`  (`:id` must be a UUID)
→ `200 { classId, subject, students: [{ childId, name, grade: string|null, bookedAt: ISO8601 }] }`
- confirmed students only
- `404 NOT_FOUND` unknown class; `400 VALIDATION_ERROR` non-uuid id

### `POST /bookings`
Header `Idempotency-Key: <uuid v4>` is **required** — a fresh one per "book"
click, the same one on a retry of that click.
Body: `{ parentId, childId, classId, simulatePayment?: "success" | "fail" | "random" }`.
`simulatePayment` defaults to `"success"` and is the only optional field.
**Unknown body keys are rejected with 422** (`ValidationPipe` `forbidNonWhitelisted`).

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ bookingId, status: "confirmed", priceCents, payment: { result: "success" } }` | booked; `priceCents` = amount "charged" |
| `200` | `{ bookingId, status: "payment_failed", priceCents, payment: { result: "fail" } }` | payment declined — offer retry |
| `409` | `{ error: "BOOKING_CLASS_FULL" }` | seat gone (race loser) |
| `409` | `{ error: "BOOKING_DUPLICATE" }` | child already has an active booking for this class |
| `409` | `{ error: "IDEMPOTENCY_IN_PROGRESS" }` | same key mid-flight |
| `422` | `{ error: "VALIDATION_ERROR" }` | bad/unknown body field, or same key reused with a different body |
| `400` | `{ error: "VALIDATION_ERROR" }` | missing / non-uuid `Idempotency-Key` |
| `404` | `{ error: "BOOKING_CHILD_NOT_FOUND" }` / `{ error: "NOT_FOUND" }` | child missing/not owned, or class missing |
| `503` | `{ error: "LOCK_TIMEOUT" }` | contention; retry (no `Retry-After` header set) |
| `503` | `{ error: "DEPENDENCY_UNAVAILABLE" }` | only if `IDEMPOTENCY_FAIL_MODE=closed` and Redis is down |

`@HttpCode(200)` — success is 200. `payment_failed` is a normal 200, not an error.

### `GET /bookings/:id`  (`:id` must be a UUID)
→ `200 { bookingId, status, classId, childId, priceCents, createdAt: ISO8601 }`
- `status` is the raw enum: `pending_payment | confirmed | payment_failed | cancelled`
- `404 NOT_FOUND` unknown

---

## 4. Data model notes

Schema in `prisma/schema.prisma`. Two migrations:
- `20260908000000_init` — tables + hand-added `CREATE EXTENSION citext`, the
  partial unique index `one_active_booking_per_child_class`
  (`(child_id, class_id) WHERE status IN ('pending_payment','confirmed')`), and
  `CHECK (capacity > 0)`.
- `20260908120000_add_price` — `price_cents INTEGER NOT NULL DEFAULT 0` on
  `trial_classes` (list price) and `bookings` (snapshot at booking time), both
  with `CHECK (price_cents >= 0)`.

`price_cents` flow: `lockClassRow` reads it under the row lock → `insertPending`
snapshots it onto the booking → carried through `BookingTxnResult.priceCents` →
`BookingResponseDto` / `BookingStatusResponseDto` / `ClassResponseDto`.

The booking transaction (`BookingsService.runBookingTxn`, HLD §6): one
`prisma.$transaction`, `SET LOCAL lock_timeout`, `SELECT ... FOR UPDATE` on the
class row, duplicate fast-path check, `COUNT(confirmed)` vs capacity, insert
`pending_payment`, run the mock payment **inside the transaction**, record the
attempt, set final status, commit. `payment_failed` commits; only
`ChildNotFound` / `ClassNotFound` / `ClassFull` / `DuplicateBooking` roll back.

---

## 5. Seed data (`prisma/seed-constants.ts` + `prisma/seed.ts`)

```
parentAlice  ...001  alice@example.com     parentBob  ...002  bob@example.com
childAmy ...011 (Alice)   childBen ...012 (Alice)   childCleo ...013 (Bob)   childDan ...014 (Bob)

classOpen      ...021  Math     +7d   $25.00   Amy confirmed          → 3 seats left
classLastSeat  ...022  Science  +8d   $30.00   Ben, Cleo, Dan conf.   → 1 seat left  (race target)
classFull      ...023  Coding   +9d   $20.00   all four confirmed     → full
```

Demo paths:
- re-book Amy into `classOpen` → `409 BOOKING_DUPLICATE`
- book a new/free child into `classFull` → `409 BOOKING_CLASS_FULL`
- book a free child into `classOpen` with `simulatePayment: "fail"` → `200 payment_failed`, roster unchanged
- fire N concurrent bookings (distinct children) at `classLastSeat` → exactly one `confirmed`, the rest `409 BOOKING_CLASS_FULL`

Seeded confirmed bookings and their `payment_attempts` use deterministic ids so
`npm run db:seed` (upsert) resets cleanly. e2e specs create their own throwaway
children under Alice for the tests that need free/distinct children.

---

## 6. Running it

```bash
# backend deps in Docker, app on host
docker compose up -d db redis
npm install
npx prisma generate            # regenerate the Prisma client after a schema change
npx prisma migrate deploy
npm run db:seed
npm run start:dev              # http://localhost:3000

# frontend (separate package — root `npm install` does NOT cover it)
cd web
cp .env.example .env           # VITE_API_BASE=/api, proxied to :3000 by Vite
npm install
npm run dev                    # http://localhost:5173

# everything in Docker (db, redis, api, web on :5173 via nginx)
docker compose up --build

# checks
npm test                       # unit, no DB
npm run build                  # nest build
npm run lint                   # oxlint
npm run test:e2e               # needs docker-compose.test.yml up (see below)
```

`.env` at the repo root is required for the backend. `PAYMENT_MOCK_MODE=true`
must be set outside production or boot fails.

---

## 7. What's NOT done / known gaps

- **e2e tests have never been run.** `test/bookings.e2e-spec.ts` (scenarios 1–6
  incl. the N=20 last-seat race) and `test/idempotency.e2e-spec.ts` (7, 7b, and
  8 as `it.skip`) need a real Postgres + Redis:
  `docker compose -f docker-compose.yml -f docker-compose.test.yml up -d db redis`
  then `npm run test:e2e`. Global setup runs `prisma migrate deploy`; tests
  truncate + re-seed between cases. The race spec relies on
  `?connection_limit=30` in the test `DATABASE_URL`.
- **`503 LOCK_TIMEOUT` sends no `Retry-After` header** (HLD §6 D-Q1 mentions one).
  Status and envelope are correct.
- **Config var name mismatch:** code and `.env.example` use `TX_TIMEOUT_MS`
  (getter `AppConfigService.txTimeoutMs`); HLD §14 / LLD §3 call it
  `BOOKING_TX_TIMEOUT_MS`. The code name wins.
- **`web/` is not a workspace.** It has its own `package.json` / lockfile; install
  and build it separately.
- **Docker `web` service** builds `web/Dockerfile` (nginx on :80 → host :5173,
  proxying `/api/` to the `api` service). Not exercised here.

---

## 8. Conventions in force (HLD §13)

Methods ≤ ~30 lines (extract the next step as a named private method past that),
DRY on the second use, typed `DomainError` subclasses (never bare `throw new
Error`), guard clauses over nesting, strict TS with no `any`, no logic in
controllers, no Prisma outside repositories, mappers for response DTOs,
`*.policy.ts` for pure rules, structured logging through `AppLogger` (one JSON
line per event, `requestId` on every line).
