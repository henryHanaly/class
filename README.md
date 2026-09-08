# Trial Booking Reliability

Trial-class booking with a mocked payment, for the Ottodot take-home. The design
write-ups are in [`claude/HLD.md`](claude/HLD.md) (what and why) and
[`claude/LLD.md`](claude/LLD.md) (how it's built).

## Running it

### What you need

| Tool | Version | When |
|---|---|---|
| Node.js | 20 or 22 | always |
| npm | comes with Node | always |
| Docker + Compose v2 | recent | the Docker setup, and the e2e tests |
| PostgreSQL | 16 | only if you run without Docker |
| Redis | 7 | only if you run without Docker |

Before anything else, copy the example env file:

```bash
cp .env.example .env            # macOS / Linux
copy .env.example .env          # Windows cmd
Copy-Item .env.example .env     # PowerShell
```

The defaults line up with the Compose files, so for Docker you don't need to
change anything. Without Docker, point `DATABASE_URL` and `REDIS_URL` at your own
Postgres and Redis. One thing to watch: `PAYMENT_MOCK_MODE=true` has to be set
outside production or the app refuses to start. Every variable has a comment in
the file, and HLD §14 explains them.

### Option A: everything in Docker

```bash
docker compose up --build
# web  http://localhost:5173   (React app, proxies /api to the API)
# API  http://localhost:3000
# Postgres 5432, Redis 6379
```

The `api` container runs `prisma migrate deploy` on start. Seed the database once
after the first boot:

```bash
docker compose exec api npx prisma db seed
```

To get back to a clean seeded state: `docker compose down -v && docker compose up --build`.

Backend only, no frontend container: `docker compose up --build db redis api`.

(I didn't get to test the full Docker path end to end, but the setup is small.)

### Option B: local, no Docker

Run your own Postgres 16 and Redis 7, then:

```bash
createdb ottodot
# edit .env, for example:
#   DATABASE_URL=postgresql://<user>:<pass>@localhost:5432/ottodot?schema=public
#   REDIS_URL=redis://localhost:6379
npm install
npx prisma migrate deploy
npm run db:seed
npm run start:dev
```

The first migration creates the `citext` extension, so the database user needs
permission for that — a superuser locally, or run `CREATE EXTENSION IF NOT EXISTS
citext;` yourself once.

### Tests

```bash
# unit tests, no database or Docker needed
npm test

# e2e tests, need a real Postgres and Redis on ports 5433 / 6380
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d db redis
npm run test:e2e
```

The e2e run applies migrations to the test database in Jest's global setup, then
truncates and re-seeds between tests. The last-seat race test fires a lot of
requests at once, so its connection string sets `?connection_limit=30`; without
that the requests queue on the pool and you end up testing the pool instead of
the row lock.

The unit suite is 53 tests across 11 files and passes. The e2e specs are written
but I couldn't run them here (no Docker in my environment) — scenario 8 (Redis
down) is `it.skip` with instructions in the file.

### Frontend

A small React (Vite) app in `web/` with its own `package.json`. It's minimal on
purpose — it makes the states visible (payment failure, the last-seat race),
nothing more. The screens are in HLD §12, and the API it consumes is written up
in `claude/FRONTEND-HANDOFF.md`.

**In Docker (Option A):** nothing to do — `docker compose up --build` already
builds the `web` service (an nginx image serving the built app and proxying
`/api/*` to the `api` container) and serves it on http://localhost:5173.

**Manually (Option B), API on the host:**

```bash
cd web
cp .env.example .env
npm install
npm run dev        # http://localhost:5173
```

The API has to be running (Docker or host). In dev, Vite proxies `/api/*` to
`http://localhost:3000` (override the target with `VITE_PROXY_TARGET`, or set
`VITE_API_BASE=http://localhost:3000` to skip the proxy and call the API
directly — CORS reflects any origin in dev). `npm run build` type-checks and
bundles to `web/dist/`.

The three views: **Book a trial** (email lookup → child → class → book, with a
`success`/`fail` payment toggle and a "fire concurrent bookings" button for the
race demo) and **Admin roster** (pick a class → table of confirmed students).

On CORS: outside production the API accepts any origin, so you can call
`http://localhost:3000` directly from a UI on any port, or from curl or Postman,
without setting anything up. In production it only allows `CORS_ORIGIN`. Before a
real deploy, set `CORS_ORIGIN` to the frontend URL and make sure
`NODE_ENV=production` so the permissive path is off.

## API endpoints

Base URL `http://localhost:3000`. All error responses share one envelope:
`{ "error": "<CODE>", "message": "<text>", "requestId": "<uuid>" }`. Both `POST`
routes return **200** on success (not 201), and `payment_failed` is a **200**, not
an error. Full detail is in [`claude/FRONTEND-HANDOFF.md`](claude/FRONTEND-HANDOFF.md) §3.

| Method | Path | Body / params | Success | Notable errors |
|---|---|---|---|---|
| `GET` | `/health` | — | `200 { status: "ok" }` | — |
| `POST` | `/parents/lookup` | `{ email }` (trimmed + lowercased) | `200 { parentId, name, children: [{ id, name, grade }] }` | `404 NOT_FOUND` (email not seeded — creates nothing), `422 VALIDATION_ERROR` |
| `GET` | `/trial-classes` | — | `200 [{ id, subject, startsAt, capacity, seatsLeft, priceCents }]` — future classes only, ordered by `startsAt`, `seatsLeft` live and never negative, `priceCents` in minor units | — |
| `GET` | `/trial-classes/:id/roster` | `:id` UUID | `200 { classId, subject, students: [{ childId, name, grade, bookedAt }] }` — confirmed only | `404 NOT_FOUND`, `400 VALIDATION_ERROR` (not a UUID) |
| `POST` | `/bookings` | header `Idempotency-Key: <uuid v4>` (required); body `{ parentId, childId, classId, simulatePayment?: "success" \| "fail" \| "random" }` (default `success`; **unknown body keys are rejected with 422**) | `200 { bookingId, status: "confirmed", priceCents, payment: { result: "success" } }` or `200 { bookingId, status: "payment_failed", priceCents, payment: { result: "fail" } }` | `409 BOOKING_CLASS_FULL` (race loser), `409 BOOKING_DUPLICATE`, `409 IDEMPOTENCY_IN_PROGRESS`, `422 VALIDATION_ERROR` (bad/unknown body field, or key reused with a different body), `400 VALIDATION_ERROR` (missing/non-uuid key), `404 BOOKING_CHILD_NOT_FOUND` / `NOT_FOUND`, `503 LOCK_TIMEOUT`, `503 DEPENDENCY_UNAVAILABLE` (Redis down + fail-closed mode) |
| `GET` | `/bookings/:id` | `:id` UUID | `200 { bookingId, status, classId, childId, priceCents, createdAt }` — `status` raw enum: `pending_payment \| confirmed \| payment_failed \| cancelled` | `404 NOT_FOUND` |

## How the code is laid out

One NestJS service, one Postgres database. Redis is only there for request
idempotency. Each domain (parents, trial classes, bookings) is its own module,
and modules don't call into each other's services — if bookings needs class data
it goes through the database.

| Folder / file | What's in it |
|---|---|
| `modules/<domain>/` | one folder per domain |
| `*.controller.ts` | HTTP only: read the DTO, call one service method, return the result |
| `*.service.ts` | the use case. One public method each. Write methods own the transaction and the seat claim; read methods don't write |
| `*.repository.ts` | all the Prisma queries for that module. Write methods take the transaction client so a use case runs as one transaction |
| `*.mapper.ts`, `*.policy.ts` | turning rows into DTOs, and small pure rules like `seatsLeft` and `canRetry` |
| `dto/` | class-validator DTOs for input, plain response DTOs so internal columns don't leak out |
| `common/utils/` | pure helpers with no DI (hashing, time). If it needs injection it's a provider, not a util |
| `infrastructure/payment.gateway.ts` | the payment interface and its mock — where a real gateway would plug in |
| `prisma/` | schema, generated client, seed script |
| `common/enums/` | shared enums, including the `BookingOutcome` code that goes into every log line and error response |
| `common/errors/` | the typed error classes and a global exception filter, so no error leaves an endpoint without being logged with its route, status and duration |
| `common/interceptors/` | a global request logger (request id, response time and status per route) and the `Idempotency-Key` handling |
| `common/logger/` | `AppLogger` — structured JSON to the console for now, swappable for an APM later without touching call sites |
| `common/redis/` | the global Redis module that provides the ioredis client; only the idempotency interceptor uses it today |
| `web/` | the React (Vite) frontend — `src/api.ts` (typed API client), `src/App.tsx` (the three views), its own `package.json` and `Dockerfile` |

A few rules I kept to: methods stay around 30 lines or less (past that, pull the
next step into a named private method), don't factor something out until it's
used twice, throw typed errors instead of bare `Error`, early returns over
nesting, strict TypeScript with no `any`, no logic in controllers, no Prisma
outside repositories.

Tests use Jest. Unit specs sit next to the file they test — services with the
repository mocked and a fake payment gateway, policies and mappers tested
directly. The e2e specs are in `test/` and run against a throwaway Postgres. The
last-seat race test is e2e only; you can't reproduce `SELECT ... FOR UPDATE`
behaviour with a mocked repository.

The directory tree, the full validator table, the log points and the test matrix
are in HLD §13 and §9.

## Assumptions

- Payment is mocked and synchronous: a function that waits a short, configurable
  delay (`PAYMENT_MOCK_DELAY_MS`, ~150 ms) and returns pass or fail. No real
  gateway, no webhook, no multi-second wait.
- Because the mock is fast, the seat check, the payment call and the status write
  all sit in one database transaction, and the seat is held only by a row lock on
  the class row for that transaction. That keeps things simple: there's no
  `pending` seat that can be abandoned, so no TTL, no sweep job, no refund path.
  It's the right call only while payment is a fast mock — a real or slow gateway
  needs the reserve → pay → confirm split (see "What I'd do next" and HLD §7.1).
- The small mock delay also widens the window where two requests can collide on
  the last seat, so the race is reproducible in the demo and the tests.
- The last-seat check is a locked read of the live confirmed count inside that
  transaction, not a separate read-then-write. That's what stops two people both
  grabbing it.
- If a payment fails, the same child can try that class again. A booking is only
  blocked while one for that child is pending or already confirmed.
- A child can be booked into more than one trial class at once. Duplicates are
  only blocked for the same child in the same class.
- Retrying the same booking request is made safe by an `Idempotency-Key` header,
  handled in a Redis-backed interceptor. It's a separate layer from the duplicate
  rule and the seat check. If Redis is down the interceptor fails open: bookings
  still work and still can't overbook or double-book (the database guarantees
  that); you just lose the clean retry-replay until Redis is back.
- No login. The parent is identified by an email lookup (`POST /parents/lookup`)
  that is trusted, not verified. It creates nothing (404 if the email isn't
  seeded), checks no password or OTP, and issues no session. It just turns a
  known email into its `parentId`, which the client passes on later calls. A real
  version would send a one-time code or magic link before returning the
  children, and issue a short-lived session. I'm assuming the child in the
  request belongs to the parent making it.
- `parentId` is a UUID the database generates at seed time. There's no parent
  registration endpoint — parents and children are seeded data.
- Spoofing a parent id can't cause overbooking or a duplicate confirmed booking.
  Capacity, duplicates and the race are all enforced server-side against the
  class row, whoever the caller claims to be. Worst case is a booking attributed
  to the wrong parent.
- The roster only ever shows confirmed bookings.
- If the same child is submitted twice for the same class at the same moment and
  it's the last seat, the second request comes back `DUPLICATE_BOOKING`, not
  `CLASS_FULL` — the duplicate check wins. It's a double-submit and the first
  booking stands.
- `GET /trial-classes/:id/roster` and `GET /bookings/:id` have no auth in this
  build. In production the roster would sit behind staff auth and a booking
  behind the owner's session. The ids are UUIDs, so not enumerable.
- The mock gateway can be driven to success or failure per request
  (`simulatePayment: "success" | "fail"`), so the walkthrough can show a
  confirmed booking and a failed one (seat stays free) side by side.
- Seed data (parents, children, classes, some pre-filled bookings) comes from a
  Prisma seed script, so anyone can reset to the same starting point.
- It's all one service and one database. No separate booking or payment service —
  the scale here doesn't call for it.

## Main decisions

- Custom NestJS API + Postgres rather than a BaaS. This is a
  transactional-integrity problem: limited seats plus money. "Create a confirmed
  booking only if confirmed count < capacity" has to be atomic, and that needs
  direct control of the transaction boundary.
- The last-seat race is handled in one transaction, in the database.
  `SELECT ... FOR UPDATE` on the class row makes everyone competing for that
  class go one at a time; inside the lock we count confirmed bookings and only
  then confirm. Whoever gets the lock first wins, the next one reads the updated
  count and is rejected. No Redis lock, no queue — at four seats and this level
  of concurrency a single row lock is enough and easiest to reason about.
- The seat is claimed in the same transaction as the payment call. Since there's
  no async gap, there's no abandoned hold, no TTL, no reconciliation job, and no
  refund path in the contention case — the loser is rejected before payment runs.
  The rule that makes this hold: seat check, payment call and status write are
  all one transaction.
- `pending_payment` doesn't consume a seat. Only `confirmed` rows do. The "hold"
  is the row lock, which lasts only for the request.
- No cached `confirmed_count` column. A counter on an inventory/money field
  drifts. The source of truth is `COUNT(*) WHERE status = 'confirmed'`, read
  under the lock.
- Three separate mechanisms for the three concerns, with no overlap: HTTP-retry
  idempotency (`Idempotency-Key` + Redis interceptor), the "one active booking
  per child + class" rule (a partial unique index), and the last-seat race (the
  `FOR UPDATE` transaction).
- The invariants live in the database, not just in app code: foreign keys, the
  partial unique index, a `CHECK` on capacity, enum types for status. App-level
  checks are for nice errors; the database is the backstop.
- Layering: controller (HTTP) → service (use case, owns the transaction) →
  repository (all Prisma) → Prisma. One module per domain, no cross-module
  service calls.

## What's not included

- A real payment gateway. Mock only. The async-webhook design (TTL holds, a
  webhook idempotency store, status polling, a reconciliation job,
  refund-on-loss) is in HLD §7 but not built.
- Auth. No login, OTP, magic link or sessions. `/parents/lookup` trusts the email.
- Parent/child sign-up. Both are seeded; there are no create endpoints.
- Regular enrollment. Trial booking only, per the brief.
- Cancellation and refunds. The `cancelled` status exists in the model but
  nothing drives it.
- Queues or workers (BullMQ, Kafka), a response cache beyond idempotency, and any
  second service. Not needed at this scale.
- Frontend polish. The UI is meant to show the states and the race, nothing more.
- Real observability. Structured logs go to the console through a swappable
  `AppLogger`; no APM is wired up.

## What I'd monitor after release

All of this is emitted as structured logs today (one JSON line per event, a
`requestId` on every line). In production the logger implementation would be
swapped for an APM exporter (Datadog, New Relic, Grafana + OpenTelemetry) with no
call-site changes, and the APM adds dashboards, alerting and traces on top of the
same events.

### Per endpoint

- Requests, latency and error rate per route, from the global request logger
  (`method`, `route`, `statusCode`, `durationMs`). The number I'd watch most is
  `POST /bookings` p95/p99, since it holds a row lock while paying.
- 5xx rate and unhandled errors. The global exception filter catches everything,
  and every 500 carries `requestId`, route and stack. Alert on a sustained 5xx
  rate, page on a spike.
- 4xx breakdown, especially 409 (`CLASS_FULL` / `DUPLICATE_BOOKING`) and 422
  (validation). A jump in 422 usually means the frontend and API have drifted
  apart. A jump in 409 near a class start time is normal; elsewhere it isn't.
- Error budget on "bookings complete in under X seconds" and on `POST /bookings`
  availability.

### Bookings

- Outcome mix: `confirmed` vs `payment_failed` vs `CLASS_FULL` vs `DUPLICATE`
  (the `BookingOutcome` on every attempt). Alert on an unusual shift.
- Time from `POST /bookings` received to `confirmed`.
- Seat fill rate and which classes hit capacity — a business signal, and it tells
  you where last-seat contention will show up.
- Lock wait time on `trial_classes` rows and any `lock_timeout` errors — early
  warning that per-class serialisation is becoming a bottleneck.
- `idem.replay` and `idem.redis_unavailable` counts — how often retries hit the
  idempotency layer, and how often it's running degraded.

### Data-integrity checks (should always be zero, page immediately)

- Any class with `COUNT(confirmed) > capacity`.
- More than one `confirmed` booking for the same `(child_id, class_id)`.
- A `confirmed` booking with no successful payment, or a successful payment whose
  booking isn't `confirmed`.
- Orphans: `payment_attempts` with no booking, bookings pointing at a missing
  child or class.

### Infrastructure

- Postgres: connection-pool use and wait time (an undersized pool looks like a
  slow database), active/idle/`idle in transaction` counts, long transactions,
  deadlocks, replication lag, disk, slow-query log.
- Redis: availability, latency, memory, evictions (evictions mean idempotency
  keys disappearing early).
- Runtime: event-loop lag, heap and GC, CPU, container restarts, OOM kills.
- Deploys: error-rate and latency change right after each release, and whether
  the migration succeeded.

### Payments

Every attempt is written to `payment_attempts` (result, `provider_ref`,
duration) and logged as `payment.attempt`, so all of this is queryable:

- Success rate — `success / (success + fail)`, overall and per window. A sudden
  drop is the first sign the gateway or our integration is broken. Alert if it
  stays below a threshold for a few minutes.
- Latency p50/p95/p99 of the gateway call. It matters double here because the
  call runs inside the seat transaction, so slow payments mean longer-held locks,
  and the `POST /bookings` p99 and lock-contention numbers move together.
- Failure reasons grouped by the gateway's decline/error code. Card declines are
  expected and user-side; timeouts and auth errors are ours.
- Gateway timeouts or unreachable — count and rate, alert fast, this blocks every
  booking.
- Attempts per booking, which should stay near 1 (a retry after failure creates a
  new booking). A rising ratio means clients are retrying because something
  upstream is failing quietly.
- With a real gateway: webhook received vs processed vs failed and the lag
  between them, duplicate events, signature failures, events for unknown orders;
  and on the money side, refunds (count, amount, reason), chargebacks,
  `payment_verified_no_seat`, and a daily reconciliation against the provider's
  totals.
- An alert if the mock gateway is somehow active outside a test environment.

### Abuse

- Auth failures once auth exists (failed OTP, expired tokens, spikes per IP).
- Idempotency-key misuse: the same key with different bodies, or one client
  cycling through many keys quickly.
- Booking rate per parent and per IP — automated attempts, seat hoarding.
- Rate-limit hits per route, once rate limiting is added.

### Alerting

Alerts route by severity through the APM's alerting into Slack, in two lanes.

Critical (page + Slack, right away): service down or `POST /bookings`
availability below target; a 5xx spike; any data-integrity check non-zero;
payment success rate below threshold or the gateway unreachable; Postgres
unreachable, pool exhausted, or a deadlock storm; a failed deploy or migration.

Warning (Slack only): endpoint p95/p99 latency regressing against a 7-day
baseline; `idem.redis_unavailable` sustained; Redis evictions climbing or
event-loop lag high; webhook failures or lag climbing (real gateway); a
`payment_failed` / `CLASS_FULL` / 422 rate that's off its usual band; refunds or
chargebacks above normal.

Each Slack message says what fired, the current value against the threshold, a
link to the relevant dashboard or trace, the `requestId`/route or SQL involved,
and a runbook link. A daily digest of the integrity checks and payment
reconciliation goes to `#eng-health` even when everything's green, so "no news"
is confirmed rather than assumed.

## What I'd do next

- Stop holding a database lock across the payment call. This is the one real
  limitation of the current design. Today the seat check, the payment call and
  the confirm are one transaction, so per-class throughput is capped at
  `1 / payment-latency` — a 5-second payment is about 12 bookings a minute for
  that class no matter how many servers you add, since they all block on the same
  Postgres row. Every waiter also holds a database connection for its whole wait,
  so one hot class can starve the rest of the API, and the gateway's latency ends
  up tied to the database's health.

  The fix is reserve → pay → confirm as three short transactions with the payment
  call in between, the lock held only for the ~1 ms database steps:
  1. Reserve (tx, ~1 ms): lock the class row, check `confirmed + active
     reservations < capacity`, insert `pending_payment` with
     `expires_at = now() + 10 min`, commit — lock released immediately.
  2. Pay (no lock, no tx): call the gateway; other seats aren't affected.
  3. Confirm (tx, ~1 ms): `pending_payment → confirmed | payment_failed`.

  Plus a background sweep (about once a minute) that expires reservations past
  `expires_at`, covering abandoned checkouts and crashed processes. Now
  `pending_payment` does hold a seat, against the TTL, throughput per class is
  around 1000 reservations a second, and no connection is pinned during payment.
  The one edge case is a reservation that expires while its payment is still in
  flight — re-check or extend before the confirm, with a
  `payment_verified_no_seat` fallback and an auto-refund. Beyond that (thousands
  of people starting checkout on one class at once, which trial classes will
  never see) you'd add an atomic single-row counter, a Redis seat counter, or a
  per-class queue. Full detail in HLD §7.1.
- A real payment gateway (Midtrans) on top of that flow: the webhook drives the
  confirm step, plus a webhook idempotency store, a status poll before the sweep
  expires a reservation, a short reconciliation loop, and the
  `payment_verified_no_seat` path. HLD §7.2.
- Auth: magic link or OTP on `/parents/lookup`, a short-lived session token, and
  ownership taken from the token instead of a trusted body field. On mobile this
  extends cleanly — authenticate once, then gate re-entry and the pay step behind
  device biometrics through the OS keychain; the biometric unlocks a stored
  refresh token locally and nothing extra reaches the backend, so the API stays a
  plain bearer token.
- Harden idempotency: persist the key and body hash (Redis now, a table if it
  needs to outlive the TTL), and keep returning 422 on key reuse with a different
  body.
- A roster admin UI: cancel a booking (which drives the `cancelled` status and
  frees the seat), export, filter by date.
- Load-test the last-seat path with realistic concurrency across several hot
  classes at once, and tune the connection pool and `lock_timeout` from real
  numbers.
- Swap the console logger for an OpenTelemetry / APM exporter and add tracing
  across request → transaction → payment call.
- More seed scenarios and some property-based concurrency tests around the race.
