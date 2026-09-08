# AI usage

## Tools used

- **Claude (chat + Claude Code)** — back-and-forth design discussion, edge-case
  pressure testing, writing up the HLD and LLD, and the implementation +
  test-writing pass.
- **Gemini (chat)** — a second independent take on the architecture, used as a
  cross-check.

## What I used AI for

- Comparing BaaS (Supabase/Firebase) vs a custom API and identifying that the
  real question is *who controls the database transaction*, not build speed. Two
  models reached the same verdict independently, which raised my confidence.
- Designing the seat-claim logic and tracing, step by step, how two competing
  last-seat bookings resolve against each other.
- Pressure-testing the design against a harder scope (async webhooks, missed
  webhooks, high contention) to find where it would need to change and where it
  wouldn't — that produced the "what I'd do next" section instead of scope creep.
- Catching edge cases the brief doesn't spell out: what "duplicate" means after
  a failed payment, whether a `pending_payment` booking holds a seat, idempotency
  key reuse.
- Laying out the NestJS modular monolith: one module per domain; controller →
  service → repository (no CQRS bus — considered it, dropped it as ceremony for
  5 one-to-one endpoints, kept the read/write split as a rule); class-validator
  DTOs per field mapped to the DB types; coding standards (≤30-line methods,
  DRY-on-second-use, typed errors); a two-layer Jest plan; and a swappable
  `AppLogger` (console now, APM later) with an outcome enum threaded through the
  logs and global per-route latency/error logging.
- Deciding how to identify a parent with no auth — landing on an email *lookup*
  step (not registration, not login), an opaque DB-generated `parentId`, and
  confirming that no-auth can't break the correctness invariants because the
  server never trusts caller identity for capacity/duplicate/race checks.
- Drafting the HLD, LLD, and README structure (I steered the content and the
  decisions; the AI did the writing-up).
- Building the minimal `web/` frontend (Vite + React, no UI or state libs) in a
  fresh Claude Code session pointed only at `claude/FRONTEND-HANDOFF.md` plus HLD
  §12 — three views, the API client, the `success`/`fail` payment toggle and the
  concurrent-booking demo button. Kept deliberately unstyled per the brief.

## How I brainstormed and pushed back on the AI (HLD and LLD)

I did not ask the AI for one answer and copy it. I went back and forth with it in
plain language and kept asking "why" until the design made sense to me. Some of
the things I kept pushing on:

- **"If user A is paying and user B pays a few seconds later, can B also pay for
  the same seat?"** I asked this many times in different ways. I wanted to be
  sure the answer was really "no", not "mostly no".
- **"Why do we need a refund at all?"** The AI first said charge both users and
  refund the loser. That felt wrong for a simple case, so I kept asking until we
  landed on: hold the seat first, then charge — so the loser never pays.
- **"Do we even need a short timer (TTL) on the pending booking?"** I wanted to
  know why it was or wasn't needed, not just be told to add one.
- **"Why not just use Redis / a queue for this?"** I pushed on this because it is
  the common answer. Working through it showed a queue would just do the same job
  as one database lock, with more moving parts, for a problem this small.
- **"What is the point of the idempotency key if we already block duplicates?"**
  I did not accept the first explanation. I kept asking until it was clear the
  key is only about retrying the same request safely, and is a separate thing
  from the "one booking per child per class" rule.
- **"No login — so how do we know which parent this is?"** I asked whether the
  email step is really a login or not, so the README would not over-claim.
- **"Where does each piece of code live?"** For the LLD I pushed for a clear
  folder layout, short methods, no repeated code, and no giant "helpers" file —
  and asked the AI to justify each layer instead of just adding layers.
- **"What breaks when this gets popular?"** I asked the AI to attack its own
  design. That is where the real limit came out (holding a DB lock during payment
  does not scale), and it went into the HLD and README honestly instead of being
  hidden.
- **LLD review before coding.** Before writing code I had the AI list every open
  question in the HLD. It found about ten (transaction timeouts, case-insensitive
  email, seed IDs, a small idempotency race, etc.). I made a decision on each one
  and wrote it into the HLD so the coding step would not have to guess.

## Where AI helped me move faster

Reasoning through the last-seat race resolution — who wins, why, and why it
doesn't depend on click order — traced explicitly before I wrote any code. That
let me lock the guarantee up front and write the concurrency test to prove it,
rather than discovering the race semantics while debugging.

## Where I disagreed with, corrected, or rejected AI output

1. **Charge-then-refund.** The first suggestion was to let both payments through
   and refund the loser. I pushed back on why a refund was needed at all, which
   led to guard-then-charge inside one transaction — the loser is rejected before
   payment runs, no refund path exists.
2. **Denormalized `confirmed_count`.** An earlier design iteration carried a
   cached counter with a guarded `UPDATE ... WHERE confirmed_count < 4`. I
   rejected it: a drifting counter on an inventory/money field is a latent
   over/under-booking bug. Replaced with `SELECT ... FOR UPDATE` + live
   `COUNT(*)`.
3. **Redis / Kafka for the race.** Rejected as solving a scale problem this
   project doesn't have (4 seats, low concurrency). A single row lock is enough.
4. **Ambiguous pending-seat semantics.** AI summaries glossed over whether a
   pending booking consumes a seat. I forced the decision (it does not, in this
   build) because it determines whether a TTL/expiry job is needed.
5. **Idempotency collapsed into the domain model.** To avoid standing up Redis
   for a 4-hour build, AI proposed an `idempotency_key` UNIQUE column on
   `bookings`, then reusing the booking id as the key. I rejected both — they
   conflate HTTP-retry idempotency with the domain uniqueness rule. Pushed for
   the standard layering: a Redis-backed `Idempotency-Key` interceptor (fail-open
   if Redis is down), a `(child_id, class_id)` partial unique index for the
   domain rule, and the `FOR UPDATE` transaction for the race — three separate
   mechanisms, no overlap, no shortcut.

## What I'd change about my AI workflow next time

I did write the HLD and LLD as their own documents before coding, and that part
worked — the coding step starts from fixed decisions, not a long chat.

What I'd change is the order *inside* the design chat. It churned more than it
needed to — the idempotency approach and the service layering were each added
then reversed once. Next time: lock the two things everything depends on first
(the data model and the one booking transaction), write those down, and only
then discuss the surrounding layers. And run the "attack your own design" pass
right after that core is frozen, not near the end — that pass is what found the
real scaling limit and the ten smaller LLD gaps, and doing it earlier would have
saved the rework.

**Keeping token use down as the codebase grows.** Lean on the repo, not one long
chat: the HLD, LLD, and a short conventions/invariants note live in the repo;
each task is a fresh session pointed at one doc section plus the few relevant
files; the agent reads/greps on demand instead of being fed pasted files; review
is `git diff`. Within a session the loaded docs are
prompt-cached, so cost is per-session, not per-turn — which is why "small anchor
file + point at sections + fresh session per task" beats a growing conversation.
A larger codebase only costs more per task if the agent has to look at more of
it; clear modules and section-numbered docs keep each task to a bounded slice.

## What I found challenging

- **Keeping scope honest.** Every pressure-test surfaced legitimate additional
  machinery (webhook idempotency, reconciliation, locks). The hard part was
  writing them down as "later" rather than building them in a 4-hour box.
- **Two internally-correct designs.** The synchronous-mock design and the
  real-gateway design both check out, but they make opposite choices
  (claim-before-charge vs charge-then-reconcile). I rejected charge-then-reconcile
  outright: charging a parent and *then* discovering the seat is gone means a
  refund, an apology, and a "sorry, actually no" — a bad experience even when the
  money comes back. Claim-before-charge can only ever tell a parent "that seat
  just went" *before* taking any money. The harder part was defending that the
  take-home's scope (synchronous mock, one transaction) genuinely supports the
  better UX rather than just being the simpler build.
- **Deciding how much to trust corroboration.** Two models agreeing on the
  architecture is weak evidence, not proof; I still had to reason it through.
- **Separating "can't happen" from "handled."** I kept probing the late-payment
  case ("A pays, B pays 5s later, confirmation lands 15s after"). The answer
  isn't a mechanism — it's that a synchronous mock *inside one transaction* has
  no time gap for that to occur. Convincing myself the gap was truly gone, and
  writing down the single rule that keeps it gone (never commit between claiming
  the seat and completing payment), took more back-and-forth than expected.
- **Naming the no-auth step honestly.** It was tempting to call the email step
  "login." Working through it clarified it's an *identify* step — it creates
  nothing, verifies nothing, issues no session — and the README should say so
  rather than overclaim.
- **Not over-engineering the concurrency answer.** I pushed AI hard on BullMQ /
  Kafka / Redis for 20+ simultaneous bookers. Working through it showed a queue
  would only *re-implement* the same per-class serialization a Postgres row lock
  already gives, and that the real lever at that concurrency is connection-pool
  sizing plus a `lock_timeout`, not the locking primitive. Choosing the boring
  option on purpose was the harder call.
- **Naming the real limit of the chosen design.** The synchronous-mock decision
  is right for the timebox, but holding a DB lock across the payment call has a
  hard ceiling (`1 / payment-latency` per class, connection-pool starvation,
  provider latency coupled to DB health). Rather than hide that, the HLD (§7.1)
  and README spell it out and give the scalable fix (reserve → pay → confirm as
  three short transactions + an expiry sweep). Being explicit that the shortcut
  *is* a shortcut felt more honest than defending it as sufficient.
- **Running an LLD review pass before coding.** A separate pass over the HLD
  surfaced ten concrete gaps (Prisma `$transaction` timeout vs the lock, `citext`
  handling, seed-UUID determinism, the `in_progress` idempotency race, `P2002`
  mapping, …). Settling each as a decision in HLD §6 / §14 — instead of leaving
  them for the coding step to rediscover — is the "write the design down first"
  principle actually paying off.

## How I verified the final implementation

- Ran the four required scenarios by hand: open seats, class at 3 confirmed,
  duplicate attempt, payment failure.
- Automated concurrency test: N simultaneous `POST /bookings` at one remaining
  seat → asserted exactly one `confirmed`, the rest rejected, and
  `COUNT(confirmed) == capacity`.
- Diffed the roster endpoint output against the `bookings` table directly.
- Seed script resets to a known state so every run starts identical.
- Unit suite (`npm test`) — 53 tests across 11 suites, all passing: booking
  service (child-not-found, class-not-found, duplicate fast-path, P2002 race,
  class-full-before-payment, payment fail/success mapping, lock_timeout→503
  (D-Q1), getById), the bookings repository (P2002 on the partial index →
  DuplicateBookingError vs rethrow, D-Q4), the prisma-error helpers
  (isUniqueViolationOn / isLockTimeout), the idempotency interceptor
  (miss/replay/in-progress/hash-mismatch on both states/SETNX-loss/fail-open/
  fail-closed/bad-key), the mock gateway, `seat.policy`, `booking.policy`, the
  body-hash util, and the mappers.
- e2e suite (`npm run test:e2e`, needs `docker-compose.test.yml` up) — HLD §9
  scenarios 1–7 incl. the N=20 last-seat race; scenario 8 (Redis down) is
  `it.skip` with run instructions inline.
- Frontend: `cd web && npm run build` type-checks (`tsc`, strict) and bundles
  clean. The client is written against the endpoint/response contract in
  `claude/FRONTEND-HANDOFF.md §3`; a manual walkthrough against a running API
  (lookup → confirmed booking → `fail` booking → duplicate → concurrent race)
  is the remaining check.
