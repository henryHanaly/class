# Trial Booking Reliability — High-Level Design

**Project:** Ottodot Full-Stack Engineer Take-Home
**Stack:** NestJS (REST API) + PostgreSQL + Prisma. Redis for HTTP-request
idempotency only (fail-open — see §4). Single modular monolith.
**Timebox:** 4 hours. Payment is mocked and synchronous.
**Status:** design locked, ready to implement.
**App structure / layering / coding standards / validation / logging / tests:** §13, §9.
**Config, error envelope, Docker, build order (LLD handoff):** §14.

---

## 1. Problem statement

Parents book and pay for a **trial class** for a child. Trial classes are capped
at **4 confirmed students**. The system must stay correct under four hostile
conditions:

1. Duplicate confirmed bookings for the same child + class.
2. Overbooking beyond 4 confirmed students.
3. Payment failure must **not** put the child on the confirmed roster.
4. **Last-seat race:** two parents both target the final seat; at most one may
   end up confirmed.

Everything else (regular enrollment, auth, real payments, notifications) is out
of scope.

---

## 2. Architecture decision

**Custom API (NestJS) + PostgreSQL, not a BaaS.**

This is a transactional-integrity problem: finite inventory + money. The core
operation is *"create a confirmed booking only if confirmed count < capacity,"*
which must be atomic. A BaaS CRUD/RLS layer cannot express that guard atomically
— you end up writing a Postgres function anyway, i.e. building a custom backend
inside someone else's runtime. A NestJS service gives direct control of the
transaction boundary where correctness lives, with no microservice overhead this
scale doesn't justify.

One monolith, one database. No separate booking/payment services. No Redis, no
queue — see §7 for why they're not needed here.

---

## 3. Data model

Postgres types shown. Enums are native Postgres enum types (Prisma `enum` →
`CREATE TYPE ... AS ENUM`), giving both a DB constraint and a TS union in the
Nest service.

```
-- enum types
booking_status  AS ENUM ('pending_payment', 'confirmed', 'payment_failed', 'cancelled')
payment_result  AS ENUM ('success', 'fail')

parents
  id            uuid          PK   DEFAULT gen_random_uuid()   -- generated at seed time
  name          text          NOT NULL
  email         citext        NOT NULL UNIQUE                  -- citext = case-insensitive

children
  id            uuid          PK   DEFAULT gen_random_uuid()
  parent_id     uuid          NOT NULL  REFERENCES parents(id) ON DELETE CASCADE
  name          text          NOT NULL
  grade         text

trial_classes
  id            uuid          PK   DEFAULT gen_random_uuid()
  subject       text          NOT NULL
  starts_at     timestamptz   NOT NULL
  capacity      smallint      NOT NULL DEFAULT 4  CHECK (capacity > 0)
  price_cents   integer       NOT NULL DEFAULT 0  CHECK (price_cents >= 0)  -- list price, minor units

bookings
  id              uuid            PK   DEFAULT gen_random_uuid()
  child_id        uuid            NOT NULL  REFERENCES children(id)       ON DELETE RESTRICT
  class_id        uuid            NOT NULL  REFERENCES trial_classes(id)  ON DELETE RESTRICT
  status          booking_status  NOT NULL DEFAULT 'pending_payment'
  price_cents     integer         NOT NULL DEFAULT 0  CHECK (price_cents >= 0)  -- amount charged, snapshotted from the class at booking time
  created_at      timestamptz     NOT NULL DEFAULT now()
  updated_at      timestamptz     NOT NULL DEFAULT now()
  -- no idempotency_key column: HTTP-retry idempotency is a separate concern,
  -- handled by the interceptor in §4, not smeared onto the domain table.

payment_attempts
  id           uuid            PK   DEFAULT gen_random_uuid()
  booking_id   uuid            NOT NULL  REFERENCES bookings(id) ON DELETE CASCADE
  result       payment_result  NOT NULL
  provider_ref text                              -- mock reference; real gateway payment-intent id
  created_at   timestamptz     NOT NULL DEFAULT now()
```

Type notes: `uuid` + `gen_random_uuid()` (built-in from PG 13; `pgcrypto` on
older). `citext` for email so lookup is case-insensitive without `lower()` on
every query. `timestamptz` (not `timestamp`) everywhere — store UTC, render in
the parent's zone. `smallint` for `capacity` — it's ≤ a few. `price_cents` is an
`integer` in **minor units** (avoids binary-float rounding) under one implied
currency — the frontend fetches it with the class list to show a review/checkout
step before booking, and each booking snapshots the class price at creation time
so a later price change doesn't rewrite history. A production build with real
payments would carry `numeric(12,2)` + an explicit currency code on a dedicated
`payments` table, never `float`.

### Relationships

```mermaid
erDiagram
    parents        ||--o{ children         : "has"
    children       ||--o{ bookings          : "books"
    trial_classes  ||--o{ bookings          : "receives"
    bookings       ||--o{ payment_attempts  : "records"

    parents {
        uuid id PK
        text name
        citext email UK
    }
    children {
        uuid id PK
        uuid parent_id FK
        text name
        text grade
    }
    trial_classes {
        uuid id PK
        text subject
        timestamptz starts_at
        smallint capacity
        integer price_cents
    }
    bookings {
        uuid id PK
        uuid child_id FK
        uuid class_id FK
        booking_status status
        integer price_cents
        timestamptz created_at
        timestamptz updated_at
    }
    payment_attempts {
        uuid id PK
        uuid booking_id FK
        payment_result result
        text provider_ref
        timestamptz created_at
    }
```

`parents → bookings` is **derived** (`bookings → children → parent_id`), not a
stored column.

| From | To | Cardinality | Notes |
|---|---|---|---|
| `parents` | `children` | 1 → many | a parent has many children; cascade delete |
| `children` | `bookings` | 1 → many | a child can be booked into many *different* classes; at most **one active** (`pending_payment`/`confirmed`) booking per `(child, class)` — partial unique index below |
| `trial_classes` | `bookings` | 1 → many | many bookings per class; **≤ `capacity` with `status='confirmed'`**, enforced in the §6 transaction, not by a constraint |
| `bookings` | `payment_attempts` | 1 → many | one attempt row per payment try; retry after `payment_failed` creates a **new booking**, so in practice ~1 attempt per booking, but the schema allows several |
| `parents` → `bookings` | — | derived | not stored; reach it via `bookings → children → parent_id`. Ownership check = `children.parent_id == request.parentId` |

No direct `parents ↔ trial_classes` link and no `parent_id` column on `bookings`
(derivable; add only as a display-only denormalization if a roster/admin view
needs it without a join).

### Booking status lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending_payment
    pending_payment --> confirmed : mock payment success
    pending_payment --> payment_failed : mock payment failure
    confirmed --> cancelled : void - no endpoint in demo
    payment_failed --> [*]
    confirmed --> [*]
    cancelled --> [*]
```

- `pending_payment` — booking row exists, seat **not yet** consumed.
- `confirmed` — payment succeeded, seat consumed, appears on roster.
- `payment_failed` — terminal for this attempt; child may retry (new booking row).
- `cancelled` — a confirmed booking later voided; frees the seat (roster excludes
  it). The status exists in the model; no cancel endpoint is built for the demo,
  and the trigger (admin action, refund flow) is out of scope.

**A seat is held only by the row lock on the `trial_classes` row, for the
duration of one transaction.** `pending_payment` is a transient in-transaction
state, never a committed row other requests can see — so there is no
abandoned-hold problem and no TTL / sweep job. The database releases the lock
itself (commit, rollback, crash, or `lock_timeout`), synchronously, as part of
ending the request. This is the key simplification (see §6).

### Constraints (the invariants live in the DB, not just app code)

```sql
-- One live booking per child per class. Blocks duplicate attempts while a
-- booking is pending or already confirmed; allows retry after failure.
CREATE UNIQUE INDEX one_active_booking_per_child_class
ON bookings (child_id, class_id)
WHERE status IN ('pending_payment', 'confirmed');
```

Capacity is **not** a static DB constraint (Postgres has no cross-row COUNT
constraint without a trigger). It is enforced at confirmation time inside a
transaction — see §6.

### Denormalized counter — deliberately omitted

The design was originally going to carry `trial_classes.confirmed_count`. Dropped
it: a cached counter can drift from the real booking rows (partial failure, manual
data fix, bug) and then silently over- or under-books. The source of truth is
`COUNT(*) FROM bookings WHERE status='confirmed'`. We serialize access with a row
lock on the `trial_classes` row (§6), so the count is always read consistently.
Tradeoff: one extra COUNT per confirmation — irrelevant at this scale. If reads
of "seats left" ever get hot, add the counter back as a **cache** with a
reconciliation job, not as the source of truth.

---

## 4. API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/parents/lookup` | `{ email }` → `{ parentId, name, children[] }` or 404. Identify step (see below) |
| `GET` | `/trial-classes` | list classes with `seatsLeft` (derived) and `priceCents` |
| `POST` | `/bookings` | create booking → runs payment → returns final status. Requires `Idempotency-Key` header |
| `GET` | `/bookings/:id` | booking status after submission |
| `GET` | `/trial-classes/:id/roster` | confirmed students only (admin/teacher) |

### `POST /parents/lookup` — identify, not auth

No login system. This endpoint **resolves a known email to its `parentId`**; the
client holds that id and passes it on later calls. It is deliberately *none* of:

| | Registration | Login / auth | `/parents/lookup` |
|---|---|---|---|
| Creates a record? | yes | no | **no** — 404 if email not seeded |
| Verifies identity ownership? | — | yes (password/OTP/magic link) | **no** — trusts the email as typed |
| Issues a session/token? | no | yes | **no** |

`parentId` is a UUID the database generates at seed time. There is **no
`POST /parents`** (registration) — parents and children are pre-seeded synthetic
data. A production version turns this into real auth by sending a one-time
code / magic link to the email before returning `children`, plus a short-lived
session token for the booking calls. Correctness does not depend on it — see §5.

### `POST /bookings` request

```
Header:  Idempotency-Key: <uuid>        (see "Idempotency" below)
Body:    { "parentId": "...", "childId": "...", "classId": "...",
           "simulatePayment": "success" }
```

`simulatePayment` (`success` | `fail` | `random`) exists only because payment is
mocked — it lets the reviewer force each scenario.

### `POST /bookings` response

```json
{ "bookingId": "...", "status": "confirmed", "priceCents": 2500,
  "payment": { "result": "success" } }
```

`priceCents` is the amount the (mock) payment charged, snapshotted from the class.
Possible `status`: `confirmed`, `payment_failed`, or `409` with a reason
(`DUPLICATE_BOOKING`, `CLASS_FULL`).

### Idempotency — a layer of its own, no overlap with the domain rules

Three independent mechanisms; each owns exactly one concern:

| Concern | Mechanism | Layer |
|---|---|---|
| Same HTTP attempt retried (lost response, double-click, client auto-retry) → replay the original result, don't re-execute | `Idempotency-Key` header + Redis-backed interceptor | HTTP / app |
| A child must not hold two active bookings for one class | `(child_id, class_id)` partial unique index | DB |
| Two users, one last seat → at most one confirmed | `SELECT … FOR UPDATE` + `COUNT(confirmed)` in the §6 transaction | DB |

**The interceptor** (NestJS `Interceptor` wrapping `POST /bookings`):

```
key := request header "Idempotency-Key"          -- reject 400 if absent
r   := redis.GET("idem:" + key)
  r == nil          -> redis.SET "idem:"+key {state: in_progress} NX EX <short>
                       run handler
                       redis.SET "idem:"+key {state: done, httpStatus, body} EX <24h>
                       return response
  r.state == done   -> return r.httpStatus, r.body           (handler NOT run)
  r.state == in_prog -> 409 "request in progress, retry shortly"
```

Exact algorithm — including the `SET NX` loser re-`GET` and the split TTL below —
is pinned in the "Settled LLD decisions" (§6, D-Q7) and LLD §4.2.

- Key is an **opaque client-generated UUID**, one per "Pay" click. It does **not**
  encode child/class ids and is **not** the booking id — it identifies the
  *attempt*, nothing else.
- **TTL:** a completed (`done`) entry lives 24h (Stripe convention); an
  `in_progress` entry gets a short TTL (~60s, `IDEMPOTENCY_INPROGRESS_TTL_S`) so a
  handler that crashes mid-flight can't wedge the key for a day.
- Redis chosen because this is ephemeral, TTL-bound request state that has no
  business being in the domain schema. A dedicated `idempotency_keys` table is
  the equally-valid alternative (what Stripe actually does); either way it is a
  **separate store**, never a column on `bookings`.

**If Redis is down** — the *correctness* invariants never depended on it. The
interceptor **fails open**: log + metric, skip the replay cache, run the handler
normally. Worst case, a lost-response retry runs the handler a second time — and
the `(child_id, class_id)` partial unique index + the seat transaction still
guarantee no duplicate confirmed booking and no overbooking. The only regression
while Redis is down is that such a retry may get a `409 DUPLICATE_BOOKING`
instead of a clean replayed `200`. (Fail-closed — 503 until Redis is back — is a
config toggle if the business prefers it.)

---

## 5. Where each check lives

| Check | UI | API | DB / infra |
|---|---|---|---|
| Field shape / type (uuid, email, enum, ranges) | basic "required" only | class-validator DTOs + global `ValidationPipe` (§13) | column types / `CHECK` |
| Retried HTTP attempt → replay, don't re-run | disable button on submit | `Idempotency-Key` interceptor | Redis (fail-open) |
| Child belongs to parent | filters dropdown | `SELECT 1 FROM children WHERE id=:childId AND parent_id=:parentId` → 403 | FK `children.parent_id` |
| Class has seats (display) | greys out full classes | returns `seatsLeft` | — |
| **Capacity enforced** | — | transaction in service | class-row lock + `COUNT(confirmed)` |
| **Duplicate active booking** | disables re-submit | catches unique violation → 409 | partial unique index |
| Payment outcome recorded | shows result | `payment_attempts` insert | — |
| Roster = confirmed only | — | `WHERE status='confirmed'` | — |

UI checks are advisory (better UX, always racy). API + DB checks are
authoritative. The race requirement is satisfied entirely in the API+DB row.

**No-auth safety:** a caller can pass any `parentId` / `childId`. Capacity,
duplicates and the last-seat race are all enforced server-side against the
class row, independent of caller identity — so a spoofed id cannot overbook or
double-book. The only consequence is a booking attributed to the wrong parent.

---

## 6. The booking transaction (core of the whole design)

`BookingsService.create()`, all inside **one** Postgres transaction
(`prisma.$transaction`), repository methods taking the `tx` client:

```
BEGIN;

-- 1. Serialize everyone competing for THIS class on one lock.
SELECT id, capacity FROM trial_classes WHERE id = :classId FOR UPDATE;

-- 2. Duplicate guard (also enforced by the partial unique index as a backstop).
--    If a pending/confirmed booking exists for (child, class) -> 409 DUPLICATE_BOOKING, ROLLBACK.

-- 3. Capacity guard, read consistently because of the lock in step 1.
SELECT COUNT(*) FROM bookings WHERE class_id = :classId AND status = 'confirmed';
--    if count >= capacity -> 409 CLASS_FULL, ROLLBACK (no payment attempted).

-- 4. Insert booking as pending_payment.
INSERT INTO bookings (child_id, class_id, status) VALUES (:childId, :classId, 'pending_payment');

-- 5. Run the MOCK payment (synchronous, small artificial delay).
--    Record the attempt in payment_attempts regardless of outcome.
--    - fail    -> UPDATE booking SET status = 'payment_failed'; COMMIT; return payment_failed
--    - success -> UPDATE booking SET status = 'confirmed';      COMMIT; return confirmed

COMMIT;
```

### Why this is correct

- **Last-seat race:** User A and User B both call `POST /bookings` for the same
  final seat. Step 1 (`FOR UPDATE` on the class row) forces them through
  one-at-a-time. Whoever's transaction acquires the lock first runs steps 3–6 to
  completion (commit or rollback) before the other even sees the row. The second
  transaction then reads `COUNT(*)` *after* the first committed — sees the seat
  gone — and is rejected at step 3, **before its mock payment runs**. Exactly one
  confirmed booking. Order is decided by the lock, not by who clicked first, and
  that's fine — the requirement is "at most one," not "first click wins."

- **Payment failure never confirms:** the `confirmed` UPDATE only runs on the
  success branch. On failure the row ends `payment_failed` and never counted
  toward capacity.

- **Crash safety:** if the process dies mid-transaction, Postgres rolls the whole
  thing back. No half-booked seat, no leaked `pending_payment` holding a seat
  (because pending never holds a seat anyway).

- **Duplicates:** step 2 handles the common case with a clean 409; the partial
  unique index is the backstop if two requests race past step 2 concurrently
  (one INSERT wins, the other gets a unique violation → mapped to 409).

### Tradeoffs accepted

- **The mock payment call happens inside an open DB transaction holding a row
  lock.** Fine for a mock with a millisecond delay. For a **real** gateway this
  is wrong — you'd never hold a Postgres lock across a multi-second external
  network call. The real-gateway design is different (see §7) and belongs in
  "what I'd do next," not here.
- **Contention is serialized per class.** All bookings for one class queue behind
  one lock. At 4 seats and tens of concurrent users, latency impact is
  negligible. At flash-sale scale it would not be — again, §7.
- **Retry after failure creates a new booking row.** Slightly more rows; keeps
  the state machine simple (no "resurrecting" a terminal booking).
- **A retried request while Redis is down** may get `409 DUPLICATE_BOOKING`
  instead of a replayed `200`. Correctness is unaffected (§4, fail-open); only
  the retry UX degrades until Redis recovers.

### Settled LLD decisions (from the LLD review pass)

- **D-Q1 — Prisma tx timeout vs the lock.** The §6 transaction holds `FOR UPDATE`
  across the mock payment, so waiters queue. Set `prisma.$transaction(fn,
  { timeout: 15000, maxWait: 15000 })` for the booking write. Keep
  `PAYMENT_MOCK_DELAY_MS` **context-dependent**: `40` in the e2e race spec
  (25 × 40 ms ≈ 1 s ≪ 15 s), `150` for manual runs, and for the demo/video cap
  the "fire N concurrent" button at ~6 or raise `PG_LOCK_TIMEOUT_MS` to `10000`
  locally. A genuine `lock_timeout` (SQLSTATE `57014`) or Prisma `P2028` →
  **`503 LOCK_TIMEOUT`** with `Retry-After`, never a fake retryable 409.
- **D-Q4 — duplicate race mapping.** Step 2's `SELECT` is a fast path only; the
  partial unique index is the guard. Catch `P2002` whose `meta.target` contains
  `one_active_booking_per_child_class` → `DuplicateBookingError` → `409
  DUPLICATE_BOOKING`.
- **D-Q5 — same `(child, class)` racing for the last seat.** Both serialize on
  the class lock; the second fails the duplicate index, so the response is
  `DUPLICATE_BOOKING`, not `CLASS_FULL`. **Accepted** — it's a double-submit, the
  first booking stands. One-line note in the README.
- **D-Q6 — no `payment_attempts` row on a rejected path.** Order is guard →
  insert → pay → record; nothing is written (and no `payment.attempt` log) unless
  the gateway actually ran. As designed.
- **D-Q7 — idempotency `in_progress` race.** Interceptor: `GET`; if nil, `SET
  key … NX`; **if `NX` returns 0, `GET` again** and treat as a hit (`done` →
  replay, `in_progress` → `409`). The `in_progress` entry gets a **short TTL
  (~60 s)**, not the 24 h key TTL — a handler that crashes mid-flight must not
  wedge the key for a day. On completion, overwrite with `{ state: 'done', … }`
  at `IDEMPOTENCY_TTL_S`.
- **D-Q8 — `random` payment is demo-only.** Every spec passes `success` or
  `fail` explicitly.
- **D-Q9 / D-Q10 — no auth on roster / `GET /bookings/:id`.** Accepted for the
  demo; README notes both would sit behind staff / session auth in production.
  UUID ids are unguessable, so no enumeration exposure.

---

## 7. What a real payment gateway would change (out of scope, documented)

With a real async gateway, payment confirmation arrives later via webhook,
possibly out of order, possibly never. That design needs:

### 7.1 The core fix: never hold a lock across the payment call

The §6 shortcut — payment call *inside* the locked transaction — has a hard
ceiling that no amount of hardware removes:

| # | Consequence of locking across the payment call |
|---|---|
| 1 | Per-class throughput is capped at `1 / payment_latency`. 5 s payments → ~12 bookings/min for that class, forever. 10 servers all block on the same Postgres row — **you cannot scale out of it**. |
| 2 | Every waiter pins one DB connection for its whole wait. 200 people on one hot class → 200 connections held → roster, lookup, other classes starve. One hot class takes down the whole API. |
| 3 | Person N waits `N × payment_latency`; p99 becomes minutes; LB/client timeouts fire; retries pile more load behind the same lock. |
| 4 | A transaction open across a network call holds back Postgres's `xmin` horizon → VACUUM can't reclaim → bloat; also blocks migrations. |
| 5 | Provider p99 spike / hang → your transactions hang with it. Their outage is your outage. |
| 6 | `lock_timeout` tuning is lose-lose: low → spurious failures under normal contention; high → one stuck payment pins the lock and everyone behind fails anyway. |

**Fix — split into three short DB transactions with the payment call *between*
them, lock held only for the ~1 ms DB steps:**

```
1. RESERVE  (tx ~1ms)   BEGIN;
                        SELECT … FROM trial_classes WHERE id=:c FOR UPDATE;
                        -- capacity = confirmed + active (non-expired) reservations
                        if full -> 409 CLASS_FULL, ROLLBACK
                        INSERT booking (status='pending_payment',
                                        expires_at = now() + interval '10 min');
                        COMMIT;                          -- lock released immediately

2. PAY      (no tx, no lock)   gateway.charge(...)       -- takes as long as it takes;
                                                        -- other seats unaffected

3. CONFIRM  (tx ~1ms)   UPDATE booking
                        SET status = :result            -- confirmed | payment_failed
                        WHERE id = :b AND status = 'pending_payment';
```

- **`pending_payment` now *does* hold a seat**, against `expires_at`. Capacity =
  `confirmed + non-expired pending`.
- **Expiry sweep (background job, every ~1 min)** — `pending_payment` past
  `expires_at` → `expired`, seat freed. Covers abandoned checkouts and crashed
  processes. This is the TTL/sweep the §6 design deliberately avoided by being
  synchronous.
- **Throughput** — the reserve step still serialises per class row, but at ~1 ms
  that's ~1000 reservations/s per class instead of `1/payment_latency`. Connection
  pool is never pinned (no wait inside a tx). Provider latency no longer touches
  DB health.
- **Refund window** — only if a reservation expires *while* its payment is
  in flight (slow gateway > TTL) and the seat is re-taken. Mitigate: TTL >
  gateway timeout, and re-check-or-extend the reservation immediately before
  `CONFIRM`; the residual case is `payment_verified_no_seat` (below).
- **Flash-sale scale** (thousands of concurrent checkout-starts on *one* class —
  not trial classes, ever): gate the reserve step with an atomic
  `UPDATE trial_classes SET reserved = reserved + 1 WHERE reserved + confirmed <
  capacity` single-row write, or a Redis atomic seat counter (`DECR`, reject at
  0) with Postgres as the durable record reconciled behind it, or a
  per-class queue so users get "you're in line" instead of a sync wait. All
  overkill for 4-seat trials; listed for completeness.

This flow also removes the need to keep the mock payment inside the lock even in
this build, if it were ever pointed at a real gateway.

### 7.2 Async webhook plumbing

- **Reserve → charge → wait for webhook, don't hold anything.** Same as 7.1 but
  step 3 (CONFIRM) is driven by the webhook, not a synchronous return.
- **Webhook idempotency store** — providers retry webhooks; process each event id
  once.
- **Active status pull, not just passive reconciliation** — the webhook is the
  fast path, not the only path. Before a hold's TTL expires, do **one
  synchronous `GET /payment_intents/:id` against the gateway** and only release
  the seat if the provider itself confirms the payment never succeeded. Also run
  a tight poll (every 1–5 min) over `pending_payment` rows past their expected
  confirmation time — a cheap loop over a handful of at-risk rows, not a full
  ledger reconciliation. The once-a-day recon job stays only as a last-resort
  backstop (provider outage that also blocked polling, stuck process).
- **Idempotent confirm handler** — webhook and poll can now both trigger the
  same "confirm this booking" logic. Key it on the provider's payment reference:
  whichever arrives first does the atomic seat claim, the other is a no-op.
- **`payment_verified_no_seat` status** — for the residual window where the pull
  itself was delayed and you discover a paid-but-seatless customer after the
  seat is gone. Tag it, surface it to a human; default policy: auto-refund +
  apology + priority on the next trial slot. Never silently make it 5-of-4.
- **Refund-on-loss** — if you charge before confirming the seat, the loser of the
  race must be refunded. The synchronous mock avoids this entirely by guarding
  before charging.
- **Redis checkout lock** (the "Ticketmaster" pattern) — only earns its keep at
  thousands of concurrent writers on one row. Not this project.

All valid, all unnecessary for a 4-hour synchronous-mock build. Listing them
shows the boundary was chosen deliberately.

### Why "payment confirmation arrives 15s later" cannot happen here

Scenario: A pays, B pays 5s later, confirmation lands 15s after — does B also get
charged for the same seat?

**No.** That failure requires payment confirmation to be *decoupled* from the
request (an async webhook). This build couples them: the mock payment call runs
**inside the same transaction that holds the seat lock**. B is blocked on the
Postgres row lock for the entire duration of A's transaction; when B unblocks,
B's capacity guard fails and **B is rejected before B's mock payment runs**.
There is no time gap, so there is nothing for a TTL, hold, or reconciliation job
to cover. The whole point of the synchronous mock is to remove that gap.

The one hard rule that makes this hold: **the seat check, the payment call, and
the status write must all be in one transaction.** If you `COMMIT` after claiming
the seat but before payment, you have reintroduced the async gap (a committed
`pending` seat that can be abandoned) and you now need a TTL and a sweep job. So:
one transaction, always.

---

## 8. Seed data

Prisma seed script → reproducible starting state (`prisma db seed` / a reset
script). Must include:

- **Parents & children:** ≥2 parents, each with ≥2 children.
- **Prices:** each class seeded with a `price_cents` (Math 2500, Science 3000,
  Coding 2000) so the review screen has something to show; seeded confirmed
  bookings snapshot their class's price.
- **Class A — open:** 1 confirmed booking, 3 seats free.
- **Class B — nearly full:** exactly 3 confirmed → 1 seat left (the last-seat
  test target).
- **Class C — full:** 4 confirmed → overbooking rejection test.
- **Duplicate case:** a child already `confirmed` in Class A, so re-booking that
  child into Class A returns `DUPLICATE_BOOKING`.
- **Payment-failure case:** documented steps — book any child into Class A with
  `simulatePayment: "fail"`, assert status `payment_failed` and roster unchanged.

---

## 9. Verification plan

All tests are **Jest**. Two layers:

### Unit tests (fast, no DB) — `*.spec.ts` next to each file

Service under test with its **repository mocked** and a **fake `PaymentGateway`**;
pure functions tested directly.

| Target | Cases |
|---|---|
| `BookingsService.create` | child-not-found → `ChildNotFoundError`; repo says seat taken → `ClassFullError`, gateway **never called**; gateway returns fail → status `payment_failed`, no confirm; gateway returns success → `confirmed`, mapper output shape; repo throws unique-violation → `DuplicateBookingError` |
| `booking.policy` | `canRetry('payment_failed') === true`, `canRetry('confirmed') === false` |
| `seat.policy` | `seatsLeft(4, 4) === 0`, `seatsLeft(4, 1) === 3`, never negative |
| `MockPaymentGateway` | `fail`/`success`/`random` honoured; returns a `provider_ref` on success |
| `IdempotencyInterceptor` | miss → handler runs + result cached; hit `done` → cached response, handler **not** called; hit `in_progress` → 409; Redis throws → handler still runs (fail-open) |
| `parent.mapper` / `booking.mapper` | internal columns absent from DTO |

### Integration / e2e tests (real Postgres) — `test/*.e2e-spec.ts`

Postgres + Redis from `docker-compose.test.yml` (§14), `prisma migrate deploy`
once in Jest global setup, hit the in-process Nest app with `supertest`. Reset
with truncate + re-seed per test. Race test: Prisma `connection_limit ≥ N` (§14).

1. **Happy path** — book into open class → `confirmed`, roster grows by 1.
2. **Duplicate** — same child + class while pending/confirmed → 409, no second row.
3. **Overbooking** — book into the full class → 409 `CLASS_FULL`, no payment
   attempt recorded.
4. **Payment failure** — `simulatePayment: fail` → `payment_failed`, seat still
   free, roster unchanged.
5. **Last-seat race (the important one)** — fire N concurrent `POST /bookings` at
   Class B's single seat with `Promise.all`; assert exactly one `confirmed`, the
   rest `CLASS_FULL`, and `COUNT(confirmed) == capacity`.
6. **Retry after failure** — child whose payment failed can book the same class
   again and succeed.
7. **Idempotency** — same `Idempotency-Key` sent twice → one booking created,
   second call returns the identical response (byte-for-byte), handler not
   re-executed. Same key with a different body → 422.
8. **Redis down (fail-open)** — with Redis stopped, a booking still succeeds; a
   naive retry returns `409 DUPLICATE_BOOKING` (documented degradation), and the
   roster still shows exactly one confirmed row.

Manual: run the four seeded scenarios through the UI / curl, diff roster endpoint
against the `bookings` table.

The last-seat race (#5) **must** be an e2e test against real Postgres — the
`FOR UPDATE` behaviour can't be reproduced with a mocked repo, so it never lives
in the unit layer.

---

## 10. Open questions / risks to watch

| Item | Risk | Mitigation in this build |
|---|---|---|
| Lock held across mock payment | Would not scale / would be wrong for real gateway | Explicitly scoped; §7 documents the real design |
| `payment_attempts` written inside the txn | On rollback (CLASS_FULL) the attempt row also rolls back — but we roll back *before* attempting payment, so nothing is lost | Order: guard → insert → pay → record |
| Per-class lock = serialized throughput | Slow under high contention | Acceptable at 4 seats / low concurrency; noted as tradeoff |
| No auth — `/parents/lookup` trusts the email, any `parentId`/`childId` can be passed | Booking mis-attributed to wrong parent | Server-side capacity/duplicate/race checks don't depend on caller identity (§5); real fix = OTP/magic link + session |
| Clock/timezone on `starts_at` | "Available" classes could include past ones | Filter `starts_at > now()` in `GET /trial-classes` |
| `Idempotency-Key` reused with a different body | Client bug could replay the wrong response | Interceptor stores a body hash with the key; mismatch → 422 |
| Redis unavailable | Retry replay lost | Interceptor fails open; DB constraints still guarantee correctness (§4) |

---

## 11. Concerns with the prior design & what changed

1. **Denormalized `confirmed_count` → removed.** Drift risk on a money/inventory
   counter isn't worth the saved COUNT. Row lock + live COUNT is the safer
   default; counter can come back later as a pure cache.
2. **"Claim-before-charge, no refund needed" → tightened.** True, but only
   because the mock is synchronous *and* we do the guard-then-charge inside one
   transaction. The prior note didn't make the single-transaction requirement
   explicit, and didn't say what releases the seat if payment fails. Answer:
   pending never holds a seat, and the transaction rolls back — so there's
   nothing to release.
3. **`pending_payment` seat semantics were ambiguous.** Now explicit: pending
   does **not** consume a seat in this build. This is what removes the need for a
   TTL / expiry job.
   3a. **Parent identity.** `GET /parents/:id/children` implied the client
   already knows the id. Replaced with `POST /parents/lookup` (email → id), an
   *identify* step that is explicitly not registration and not auth. No parent
   creation endpoint. Server-side correctness checks don't trust caller identity,
   so no-auth can't cause overbooking.
4. **Guarded `UPDATE ... WHERE confirmed_count < 4` → replaced** with
   `SELECT ... FOR UPDATE` + `COUNT(*)`. Same atomicity guarantee, but works
   without the denormalized counter and reads more obviously correct.
5. **Idempotency un-tangled from the domain model.** The prior design put an
   `idempotency_key` UNIQUE column on `bookings` and, at one point, considered
   reusing the booking id as the key. Both conflate two separate concerns.
   Correct layering (§4): HTTP-retry idempotency is a Redis-backed interceptor
   keyed on an opaque `Idempotency-Key` header; the domain rule "one active
   booking per child+class" is the partial unique index; the last-seat race is
   the `FOR UPDATE` transaction. No column on `bookings`, and the design still
   holds if Redis is down.
6. **CQRS bus dropped, layering kept.** Started with `@nestjs/cqrs`
   command/query handlers; simplified to plain per-module services
   (controller → service → repository) — the service method *is* the use case.
   The read/write split stays as a discipline. Coding standards (method ≤ 30
   lines, DRY-on-second-use, typed errors, no logic in controllers, no Prisma
   outside repositories) and a two-layer Jest plan (unit with mocked repo +
   fake gateway; e2e on real Postgres for the race) added in §13 / §9.

---

## 12. Frontend (minimal — demonstrates states, not polish)

The brief explicitly does not grade frontend polish. The UI's only job is to make
the invariants **visible** — especially the payment-failure and last-seat-race
outcomes, for the walkthrough video.

**Stack:** plain React (Vite) or a single static HTML page + `fetch`, calling the
NestJS API. No Next.js, no routing lib, no component library, no state-management
lib. Views toggled by a `view` state variable: parent → review → result, plus a
standalone roster view.

### View 1 — Parent: pick child + class

- Email field → `POST /parents/lookup` → returns `parentId` + children (held in
  state for the session; no token). A demo shortcut of a parent dropdown from
  `GET /parents` is acceptable too.
- Child dropdown (from the lookup response).
- Class list: subject, `starts_at`, **price** (`priceCents`, from
  `GET /trial-classes`), and **seats left** (`capacity - confirmed`). Full
  classes shown greyed/disabled.
- A `simulatePayment` toggle (`success` / `fail`) — dev affordance so the
  reviewer can force each path.
- "Review & book" button → the review view (no request yet).

### View 1b — Review & pay

A confirmation step before any money moves: shows the chosen child, class, date,
and the **price** pulled from the class. "Confirm & pay {price}" is what actually
sends `POST /bookings` (a fresh `Idempotency-Key` generated here, button disabled
while in flight). The seat claim and the mock payment still happen together
server-side in that one call — the review screen is UX only, not a
reserve-then-pay split (that's §7.1, out of scope).

### View 2 — Booking result (maps status → plain language)

| API result | Message shown |
|---|---|
| `confirmed` | "Booked — {child} is confirmed for {class}. Charged {price}." |
| `payment_failed` | "Payment didn't go through. Try again." + retry button |
| `409 CLASS_FULL` | "Sorry, that seat was just taken." |
| `409 DUPLICATE_BOOKING` | "You already have a booking for this class." |

### View 3 — Admin/teacher roster (read-only)

Pick a class → table of **confirmed children only**, from
`GET /trial-classes/:id/roster`. Plain `<table>`, no styling budget.

### Demo affordances (for the video)

- **"Fire N concurrent bookings"** button — sends up to ~6 `POST /bookings` for
  the same last seat via `Promise.all` (cap kept low so the queued lock waits
  stay under `PG_LOCK_TIMEOUT_MS`; see D-Q1), so the race resolution (one
  `confirmed`, the rest `409 CLASS_FULL`) is visible on screen. The mock payment
  delay widens the collision window.
- **`simulatePayment` toggle** — book once with `success` (→ `confirmed`, roster
  grows) and once with `fail` (→ `payment_failed`, seat stays free, roster
  unchanged), so the video shows both payment outcomes.

### Deliberately cut

Styling beyond minimal CSS, spinners, client-side validation past "child + class
selected", routing, auth screens, responsive layout, parent sign-up (parents are
seeded; `/parents/lookup` only resolves an existing email).

---

## 13. Application structure (NestJS — modular monolith)

One deployable, one database. Each domain is a self-contained Nest module
(`ParentsModule`, `TrialClassesModule`, `BookingsModule`) that exposes a
controller + a service and imports only `PrismaModule` + `CommonModule`.
Modules do **not** import each other's services — if `bookings` needs class data
it goes through the DB, so a module could later be split out without untangling
call graphs.

Prisma **is the model layer** (generated types + client).

### Layering — how a request flows

```
controller  ->  service            ->  repository   +  gateway
 (HTTP only)     (use-case logic,       (all Prisma     (payment,
                  transaction           access for      external)
                  boundary)             the module)
                                            |
                                     Prisma client = data mapper
```

- **Controller** — routing only: one method per endpoint, binds the DTO, calls
  **one** service method, returns its result. No logic, no mapping, no DB. If a
  controller method has a branch or a loop, it's in the wrong place.
- **Service** — the use-case logic. One public method per use case
  (`create()`, `getById()`, `getRoster()`, `lookup()`). Owns the
  `prisma.$transaction` for writes. The §6 seat claim lives here.
- **Repository** — the only place Prisma queries are written for that module
  (`BookingsRepository.claimSeatAndInsert(tx, …)`, `.findActive(childId, classId)`).
  Write methods take the transaction client so the whole use case is one
  transaction. Tests stub this seam.
- **Mapper** (`*.mapper.ts`) — Prisma row → response DTO. Called by the service,
  never by the controller.
- **Infrastructure** — `PaymentGateway` interface + `MockPaymentGateway`; Midtrans
  later is a new impl of the same interface, tests inject a fake.

No `CommandBus` / `QueryBus` — the service methods are the use cases. (The
command/query *split* still holds as a discipline: read methods never write.)

### Coding standards (enforced in review; lint where possible)

- **Method length ≤ ~30 lines.** If a method grows past that, extract the next
  cohesive step into a private, well-named method (`assertChildBelongsToParent`,
  `claimSeat`, `runPayment`, `toResponse`). A long method is a list of unnamed
  steps; naming them *is* the documentation.
- **DRY — extract on the second use.** Logic needed by two methods in a module
  moves to a private method (same class) or a `*.policy.ts` / `*.mapper.ts` /
  `common/utils/` function if it's pure and reusable. Not before the second use
  (premature abstraction), not after the third (copy-paste rot).
- **One reason to change per class.** Controller = transport, service = use case,
  repository = persistence, mapper = shape, policy = a rule. A method that spans
  two of these is split.
- **No logic in controllers, no Prisma outside repositories, no `any`.**
  `strict` TS, `readonly` on injected deps, return types explicit on public
  methods.
- **Guard clauses over nesting** — validate-and-throw early, keep the happy path
  at one indent level.
- **Errors are typed** (`ClassFullError`, `DuplicateBookingError` extend
  `DomainError`), never bare `throw new Error('...')`. Each carries a
  `BookingOutcome` + HTTP status; the global filter maps and logs.
- **Names say intent** — `confirmedSeats`, not `cnt`; `hasActiveBooking`, not
  `check`.
- **Helpers named by responsibility** — no `helpers.ts` / `misc.ts` / `utils.ts`
  grab-bag. Pure cross-module functions live in `common/utils/<topic>.ts`;
  per-module pure rules in `*.policy.ts` / `*.calculator.ts`.

### Directory layout

```
src/
  main.ts
  app.module.ts

  common/
    logger/
      logger.service.ts        # AppLogger: info|warn|error|debug(msg, context)
      logger.module.ts         # console impl now; APM exporter later, same interface
    redis/
      redis.module.ts          # @Global: provides REDIS_CLIENT (ioredis), config-
                               #   driven URL, lazyConnect, error listener -> AppLogger
      redis.constants.ts       # REDIS_CLIENT injection token
    enums/
      booking-status.enum.ts   # mirrors Prisma booking_status
      payment-result.enum.ts   # mirrors Prisma payment_result
      booking-outcome.enum.ts  # CONFIRMED | PAYMENT_FAILED | CLASS_FULL | DUPLICATE | CHILD_NOT_FOUND
      simulate-payment.enum.ts # request-only: SUCCESS | FAIL | RANDOM
    errors/
      domain.error.ts          # base: has an outcome code + http status
      class-full.error.ts
      duplicate-booking.error.ts
      child-not-found.error.ts
      all-exceptions.filter.ts    # GLOBAL (APP_FILTER): catches everything, logs
                                  #   route + durationMs + status, nothing escapes
      domain-exception.filter.ts  # booking DomainError -> HTTP body mapping
    interceptors/
      idempotency.interceptor.ts       # §4: injects REDIS_CLIENT, fail-open on any
                                       #   Redis error (POST /bookings only)
      request-logging.interceptor.ts   # GLOBAL (APP_INTERCEPTOR): requestId +
                                       #   per-route latency/status on every endpoint
    pipes/
      # global ValidationPipe configured in main.ts
    utils/
      hash.ts                  # pure: idempotency body hash
      time.ts                  # pure: now(), isPast()
      # pure/stateless only — no DI, no DB. Needs injection => it's a provider.

  prisma/
    schema.prisma
    prisma.service.ts
    prisma.module.ts
    seed.ts

  modules/
    parents/
      parents.module.ts
      parents.controller.ts          # POST /parents/lookup -> parentsService.lookup()
      parents.service.ts             # lookup() use case
      parents.repository.ts          # all Prisma access for this module
      parent.mapper.ts               # row -> ParentResponseDto
      parents.service.spec.ts
      dto/
        lookup-parent.dto.ts
        parent-response.dto.ts

    trial-classes/
      trial-classes.module.ts
      trial-classes.controller.ts
      trial-classes.service.ts       # listWithSeatsLeft(), getRoster()
      trial-classes.repository.ts
      trial-class.mapper.ts
      seat.policy.ts                 # pure: seatsLeft(capacity, confirmed)
      trial-classes.service.spec.ts
      seat.policy.spec.ts
      dto/
        class-response.dto.ts
        roster-response.dto.ts

    bookings/
      bookings.module.ts
      bookings.controller.ts         # POST /bookings, GET /bookings/:id
      bookings.service.ts            # create() owns the $transaction (§6); getById()
      bookings.repository.ts         # claimSeatAndInsert(tx,…), findActive(…), …
      booking.mapper.ts              # row -> BookingResponseDto
      booking.policy.ts              # pure: canRetry(status)
      bookings.service.spec.ts       # unit: mocked repo + fake gateway
      booking.policy.spec.ts
      infrastructure/
        payment.gateway.ts           # interface
        mock-payment.gateway.ts      # setTimeout delay + pass/fail
      dto/
        create-booking.dto.ts
        booking-response.dto.ts

test/
  bookings.e2e-spec.ts               # §9 scenarios 1-8, real Postgres
  idempotency.e2e-spec.ts            # §9 scenarios 7-8
```

Reads and writes still don't mix: a service method either reads or it mutates
inside a transaction — never both loosely.

### Shared modules (`@Global`, wired once in `app.module.ts`)

`PrismaModule`, `LoggerModule`, `RedisModule` are each `@Global()` and imported
**once** by `AppModule`. Any domain module then injects `PrismaService`,
`AppLogger`, or `REDIS_CLIENT` directly — no per-module `imports: [RedisModule]`,
nothing touching `app.controller`. The global interceptors (`APP_INTERCEPTOR`)
and filters (`APP_FILTER`) are also registered here, so `main.ts` only
bootstraps + sets the `ValidationPipe`. `app.controller.ts` is just a health
check (`GET /health`) — it holds no wiring.

### Field validation (class-validator DTOs + global `ValidationPipe`)

`ValidationPipe` set in `main.ts` with `whitelist: true,
forbidNonWhitelisted: true, transform: true` — unknown fields are rejected, types
coerced. Per field, matched to the DB type:

```ts
// create-booking.dto.ts
export class CreateBookingDto {
  @IsUUID('4')  parentId!: string;          // uuid FK
  @IsUUID('4')  childId!: string;           // uuid FK
  @IsUUID('4')  classId!: string;           // uuid FK

  @IsOptional()
  @IsEnum(SimulatePayment)                  // SUCCESS | FAIL | RANDOM
  simulatePayment: SimulatePayment = SimulatePayment.SUCCESS;
}

// header, validated in idempotency.interceptor.ts
//   Idempotency-Key: required, @IsUUID('4') (reject 400 if missing/malformed)

// lookup-parent.dto.ts
export class LookupParentDto {
  @IsEmail() @MaxLength(320) @Transform(({ value }) => value.trim().toLowerCase())
  email!: string;                           // citext column
}

// params
//   :id path params -> ParseUUIDPipe
```

| DB type | Validator |
|---|---|
| `uuid` | `@IsUUID('4')` / `ParseUUIDPipe` |
| `citext` email | `@IsEmail()` `@MaxLength(320)` + lowercase transform |
| `text` (name, subject) | `@IsString()` `@IsNotEmpty()` `@MaxLength(n)` |
| `timestamptz` (query filters) | `@IsISO8601()` |
| `smallint` | `@IsInt()` `@Min(1)` `@Max(…)` |
| enum column | `@IsEnum(TheEnum)` |

Responses go through explicit `*-response.dto.ts` classes (or a
`ClassSerializerInterceptor`) so internal columns never leak.

### Enums for outcomes, and how they flow through logs

`booking-outcome.enum.ts`:

```ts
export enum BookingOutcome {
  CONFIRMED       = 'BOOKING_CONFIRMED',
  PAYMENT_FAILED  = 'BOOKING_PAYMENT_FAILED',
  CLASS_FULL      = 'BOOKING_CLASS_FULL',
  DUPLICATE       = 'BOOKING_DUPLICATE',
  CHILD_NOT_FOUND = 'BOOKING_CHILD_NOT_FOUND',
}
```

- **Success paths** — `CreateBookingHandler` ends by emitting the outcome:
  `logger.info('booking.outcome', { outcome: BookingOutcome.CONFIRMED, bookingId, classId, childId, paymentRef })`
  (or `PAYMENT_FAILED` on the fail branch — a normal outcome, logged at `info`).
- **Rejections thrown + caught** — `ClassFullError` / `DuplicateBookingError`
  carry their `BookingOutcome` code and an HTTP status. `domain-exception.filter.ts`
  catches them, logs once (`logger.warn('booking.rejected', { outcome, classId,
  childId })`), and returns `{ error: outcome, message }`. Unexpected errors →
  `logger.error(...)` + 500.
- The same `BookingOutcome` string is what the frontend switches on (§12) and
  what an APM dashboard would group by.

### Logging → APM (console now, swap later)

`AppLogger` is a thin interface (`info|warn|error|debug(event: string, context:
object)`) with a `ConsoleLogger` implementation today — structured JSON to
`console`, one line per event. Swapping to an APM (Datadog / New Relic / OTel
collector) later is a new implementation of the same interface bound in
`LoggerModule`; no call sites change.

**Every endpoint is covered, not just bookings.** Two components are registered
**globally** in `app.module.ts` (`APP_INTERCEPTOR` / `APP_FILTER`), so they wrap
every controller in every module automatically:

- **`RequestLoggingInterceptor` (global)** — on every request, generates a
  `requestId`, records start time, and on completion logs one `http.response`
  line with `method`, `route` (the path *pattern*, e.g. `GET /bookings/:id`, so
  metrics group per endpoint not per id), `statusCode`, and `durationMs`. This is
  the data you slice later to see which endpoint is slow or erroring.
- **`AllExceptionsFilter` (global)** — catches everything that throws from any
  handler. Known `DomainError`s → `warn` with their `BookingOutcome` code + HTTP
  status; anything else → `error` with stack + `requestId` + 500. Either way the
  same `route` and `durationMs` are logged, so a failing endpoint shows up in the
  same per-route view as a slow one.

`DomainExceptionFilter` for the booking-specific mapping either extends or is
composed into `AllExceptionsFilter` — the global one is the safety net so **no
error escapes unlogged**.

Instrumented points:

| Where | Scope | Event | Fields | Level |
|---|---|---|---|---|
| `RequestLoggingInterceptor` | **every endpoint** | `http.response` | `requestId, method, route, statusCode, durationMs` | info (4xx → warn, 5xx → error) |
| `AllExceptionsFilter` | **every endpoint** | `request.error` | `requestId, route, statusCode, durationMs, errorName, outcome?, stack?` | warn / error |
| `IdempotencyInterceptor` | `POST /bookings` | `idem.replay` / `idem.redis_unavailable` | `requestId, key` | info / warn |
| `BookingsService.create` | booking write | `booking.outcome` | `requestId, outcome, bookingId, classId, childId, paymentRef` | info |
| `MockPaymentGateway` | booking write | `payment.attempt` | `requestId, result, ref, durationMs` | info |

Every line carries the `requestId`, so one request is traceable across the
interceptor, the handler, the payment call, and any error. Per-route
`durationMs` + `statusCode` are exactly the two series an APM needs to rank
endpoints by latency and error rate once the console impl is swapped out.

Alert routing (severity lanes, Slack channels, anomaly detection, daily green
digest) is in `README.md` → "What I would monitor after release".

---

## 14. Implementation notes & build order (for the LLD)

Everything an LLD/coding pass needs that isn't already pinned above.

### Config / env vars (`@nestjs/config`, validated on boot)

| Var | Example | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production`; gates the mock-mode assertion below |
| `DATABASE_URL` | `postgresql://ottodot:ottodot@localhost:5432/ottodot?schema=public` | Postgres |
| `REDIS_URL` | `redis://localhost:6379` | idempotency store |
| `PORT` | `3000` | HTTP |
| `CORS_ORIGIN` | `http://localhost:5173` | frontend origin |
| `PAYMENT_MOCK_MODE` | `true` | must be `true` outside prod; startup asserts it |
| `PAYMENT_MOCK_DELAY_MS` | `150` | artificial delay. `40` in the e2e race spec, `150` manual/demo (D-Q1) |
| `PAYMENT_MOCK_FAIL_RATE` | `0` | `0..1`; `simulatePayment=random` only (demo) |
| `BOOKING_TX_TIMEOUT_MS` | `15000` | `prisma.$transaction` `timeout` + `maxWait` for the booking write (D-Q1) |
| `PG_LOCK_TIMEOUT_MS` | `3000` | `SET lock_timeout` per booking txn. Raise to `10000` for local/demo if firing many concurrent (D-Q1) |
| `PG_POOL_SIZE` | `20` | Prisma `connection_limit`; **must be ≥ the race test's N** |
| `IDEMPOTENCY_TTL_S` | `86400` | Redis key TTL for a completed (`done`) entry |
| `IDEMPOTENCY_INPROGRESS_TTL_S` | `60` | TTL for an `in_progress` entry — a crashed handler must not wedge the key (D-Q7) |
| `IDEMPOTENCY_FAIL_MODE` | `open` | `open` = run handler if Redis down; `closed` = 503 |
| `RESERVATION_TTL_MIN` | `10` | *§7 scalable flow only* — hold window before the sweep expires a `pending_payment` |

Boot fails if any required var is missing or `PAYMENT_MOCK_MODE!=true` while
`NODE_ENV=production`.

### Error envelope (all 4xx/5xx)

```json
{ "error": "BOOKING_CLASS_FULL", "message": "This class is full.", "requestId": "…" }
```

`error` is a `BookingOutcome` (or `VALIDATION_ERROR`, `NOT_FOUND`,
`INTERNAL_ERROR`, `LOCK_TIMEOUT`). Status map: `DUPLICATE`/`CLASS_FULL` → 409,
`CHILD_NOT_FOUND` → 404, validation → 422, missing/invalid `Idempotency-Key` →
400, idempotency in-progress → 409, Redis-closed mode → 503, `lock_timeout`
(`57014`) / Prisma `P2028` → **503 `LOCK_TIMEOUT`** + `Retry-After` (D-Q1),
unexpected → 500. `payment_failed` is **200** with `status: "payment_failed"` —
a normal outcome, not an error.

### `GET /trial-classes` — seatsLeft without N+1

One query, not one-per-class:

```sql
SELECT c.id, c.subject, c.starts_at, c.capacity, c.price_cents,
       c.capacity - COALESCE(b.confirmed, 0) AS seats_left
FROM trial_classes c
LEFT JOIN (
  SELECT class_id, COUNT(*) AS confirmed
  FROM bookings WHERE status = 'confirmed' GROUP BY class_id
) b ON b.class_id = c.id
WHERE c.starts_at > now()
ORDER BY c.starts_at;
```

Live count — no cached column (§3).

### Idempotency interceptor details

- Key: `Idempotency-Key` header, `@IsUUID('4')`, required on `POST /bookings`.
- Redis value: `{ state: 'in_progress'|'done', bodyHash, httpStatus?, body? }`,
  `EX IDEMPOTENCY_TTL_S`, written with `SET … NX` to claim.
- `bodyHash` = sha256 of the canonical `{parentId, childId, classId,
  simulatePayment}` JSON. Same key + different hash → `422 VALIDATION_ERROR`
  (key reuse).
- Any Redis error → log `idem.redis_unavailable`, then behave per
  `IDEMPOTENCY_FAIL_MODE`.

### Seed script (`prisma/seed.ts`) — deterministic

Fixed UUIDs for every seeded row (constants the tests and the frontend import),
`upsert` so re-running resets cleanly. Contents = §8. Add a `db:reset` script
(`migrate reset --force && db seed`).

### Test infrastructure

- **Dependencies via Docker Compose**, not Testcontainers — one `docker-compose.yml`
  (Postgres + Redis + optional `api`) plus a `docker-compose.test.yml` overlay
  (isolated ports `5433`/`6380`, DB `ottodot_test`, no volume). Simpler to run and
  inspect than Testcontainers for this size; the app itself is **not** required
  to run in Docker.
- **Migrations in test setup**: global Jest setup runs `prisma migrate deploy`
  against the test DB once, then each test truncates + re-seeds (faster than
  `migrate reset` per test).
- **e2e app**: Nest `Test.createTestingModule` in-process against the compose
  Postgres/Redis (the `api` compose service is disabled for tests).
- **Race test pool sizing**: the Prisma client under test needs
  `connection_limit ≥ N` where N is the number of concurrent `POST /bookings` the
  test fires — otherwise requests queue on the pool and the test measures pool
  starvation, not the row lock. Set it explicitly in the test DATABASE_URL
  (`?connection_limit=30`) and fire N=20–25.

### Docker files (in repo root)

- `Dockerfile` — multi-stage (build → prune dev deps → slim runtime), non-root
  user, `CMD` runs `prisma migrate deploy` then `node dist/main.js`.
- `.dockerignore`, `docker-compose.yml`, `docker-compose.test.yml` as above.

### Build order

1. `schema.prisma` + first migration + `seed.ts` (deterministic UUIDs).
2. `common/`: config, `PrismaModule`, `RedisModule`, `LoggerModule`, enums,
   `DomainError` + subclasses, `AllExceptionsFilter`, `RequestLoggingInterceptor`.
3. `bookings` module: repository (`claimSeatAndInsert` = §6) → service → controller.
4. `PaymentGateway` interface + `MockPaymentGateway`.
5. `IdempotencyInterceptor` + Redis wiring.
6. `trial-classes` and `parents` modules (queries only).
7. Unit specs alongside each file; then `test/*.e2e-spec.ts` incl. the race.
8. Frontend (§12).
9. `Dockerfile` / compose, README run steps, `AI-usage.md` (repo root).
