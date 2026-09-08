# Trial Booking Reliability — Low-Level Design

**Companion to:** [HLD.md](./HLD.md). The HLD fixes *what* and *why*; this LLD
fixes *how* — concrete types, method signatures, SQL, Prisma calls, error
mapping, config wiring, and file-by-file contracts a coding pass can implement
without re-deciding anything.

**Stack pinned:** NestJS 10 · TypeScript 5 (`strict`) · Prisma 5 · PostgreSQL 16
· ioredis 5 · Jest 29 + supertest · Node 20.

Section numbers below map onto HLD sections where relevant (LLD §6 ⇄ HLD §6).
The design questions this LLD raised on its first pass are all resolved and
recorded in **HLD §6 → "Settled LLD decisions" (D-Q1, D-Q4–D-Q10)**; inline
notes below point there.

---

## 1. Type & enum definitions (single source per concept)

### 1.1 Prisma schema enums (DB-backed)

```prisma
enum BookingStatus {
  pending_payment
  confirmed
  payment_failed
  cancelled
}

enum PaymentResult {
  success
  fail
}
```

### 1.2 App enums (`src/common/enums/`)

```ts
// booking-status.enum.ts — mirrors Prisma BookingStatus, used where we don't
// want to import the generated enum into DTO/policy layers.
export enum BookingStatus {
  PendingPayment = 'pending_payment',
  Confirmed      = 'confirmed',
  PaymentFailed  = 'payment_failed',
  Cancelled      = 'cancelled',
}

// payment-result.enum.ts
export enum PaymentResult { Success = 'success', Fail = 'fail' }

// simulate-payment.enum.ts — request input only
export enum SimulatePayment { Success = 'success', Fail = 'fail', Random = 'random' }

// booking-outcome.enum.ts — the string that flows into logs, error envelope,
// and the frontend switch (HLD §13).
export enum BookingOutcome {
  Confirmed     = 'BOOKING_CONFIRMED',
  PaymentFailed = 'BOOKING_PAYMENT_FAILED',
  ClassFull     = 'BOOKING_CLASS_FULL',
  Duplicate     = 'BOOKING_DUPLICATE',
  ChildNotFound = 'BOOKING_CHILD_NOT_FOUND',
}

// error-code.enum.ts — non-booking envelope codes
export enum ErrorCode {
  Validation    = 'VALIDATION_ERROR',
  NotFound      = 'NOT_FOUND',
  IdempInProgress = 'IDEMPOTENCY_IN_PROGRESS',
  RedisClosed   = 'DEPENDENCY_UNAVAILABLE',
  LockTimeout   = 'LOCK_TIMEOUT',
  Internal      = 'INTERNAL_ERROR',
}
```

### 1.3 Cross-layer domain types (`src/modules/bookings/booking.types.ts`)

```ts
export interface PaymentChargeResult {
  result: PaymentResult;
  providerRef: string | null;   // set on success, null on fail
  durationMs: number;
}

export interface BookingCreationResult {
  bookingId: string;
  status: BookingStatus.Confirmed | BookingStatus.PaymentFailed;
  priceCents: number;               // snapshot of the class price that was charged
  payment: { result: PaymentResult };
}
```

---

## 2. Prisma schema (`prisma/schema.prisma`)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Parent {
  id       String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name     String
  email    String   @unique @db.Citext
  children Child[]

  @@map("parents")
}

model Child {
  id        String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  parentId  String    @map("parent_id") @db.Uuid
  name      String
  grade     String?
  parent    Parent    @relation(fields: [parentId], references: [id], onDelete: Cascade)
  bookings  Booking[]

  @@index([parentId])
  @@map("children")
}

model TrialClass {
  id         String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  subject    String
  startsAt   DateTime  @map("starts_at") @db.Timestamptz(6)
  capacity   Int       @default(4) @db.SmallInt
  priceCents Int       @default(0) @map("price_cents")   // list price, minor units
  bookings   Booking[]

  @@map("trial_classes")
}

model Booking {
  id         String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  childId    String        @map("child_id") @db.Uuid
  classId    String        @map("class_id") @db.Uuid
  status     BookingStatus @default(pending_payment)
  priceCents Int           @default(0) @map("price_cents")   // snapshot of the class price at booking time
  createdAt  DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime      @updatedAt @map("updated_at") @db.Timestamptz(6)

  child           Child            @relation(fields: [childId], references: [id], onDelete: Restrict)
  trialClass      TrialClass       @relation(fields: [classId], references: [id], onDelete: Restrict)
  paymentAttempts PaymentAttempt[]

  @@index([classId, status])
  @@map("bookings")
}

model PaymentAttempt {
  id          String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  bookingId   String        @map("booking_id") @db.Uuid
  result      PaymentResult
  providerRef String?       @map("provider_ref")
  createdAt   DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  booking     Booking       @relation(fields: [bookingId], references: [id], onDelete: Cascade)

  @@index([bookingId])
  @@map("payment_attempts")
}
```

### 2.1 Hand-added migration SQL (not expressible in `schema.prisma`)

Appended to the generated first migration (`prisma migrate dev --create-only`,
then edit):

```sql
-- case-insensitive email
CREATE EXTENSION IF NOT EXISTS citext;

-- HLD §3: one live booking per child per class; retry allowed after failure
CREATE UNIQUE INDEX one_active_booking_per_child_class
  ON bookings (child_id, class_id)
  WHERE status IN ('pending_payment', 'confirmed');

-- HLD §3: capacity sanity (per-row; cross-row count enforced in the txn)
ALTER TABLE trial_classes ADD CONSTRAINT trial_classes_capacity_positive CHECK (capacity > 0);
```

A later migration (`20260908120000_add_price`) adds the price columns:

```sql
ALTER TABLE trial_classes ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings      ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trial_classes ADD CONSTRAINT trial_classes_price_cents_nonneg CHECK (price_cents >= 0);
ALTER TABLE bookings      ADD CONSTRAINT bookings_price_cents_nonneg      CHECK (price_cents >= 0);
```

---

## 3. Config module (`src/common/config/`)

`@nestjs/config` with a Joi schema; `ConfigModule.forRoot({ isGlobal: true,
validationSchema, validationOptions: { abortEarly: false } })`.

```ts
// config.schema.ts
export const configSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  DATABASE_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  PORT: Joi.number().port().default(3000),
  CORS_ORIGIN: Joi.string().uri().default('http://localhost:5173'),
  PAYMENT_MOCK_MODE: Joi.boolean().default(true),
  PAYMENT_MOCK_DELAY_MS: Joi.number().min(0).max(5000).default(150),
  PAYMENT_MOCK_FAIL_RATE: Joi.number().min(0).max(1).default(0),
  PG_LOCK_TIMEOUT_MS: Joi.number().min(0).default(3000),
  PG_POOL_SIZE: Joi.number().min(1).default(20),
  BOOKING_TX_TIMEOUT_MS: Joi.number().min(1000).default(15000),   // HLD §6 D-Q1
  IDEMPOTENCY_TTL_S: Joi.number().default(86400),                 // completed ("done") key
  IDEMPOTENCY_INPROGRESS_TTL_S: Joi.number().default(60),         // HLD §6 D-Q7: crashed handler must not wedge the key
  IDEMPOTENCY_FAIL_MODE: Joi.string().valid('open', 'closed').default('open'),
})
  // HLD §14: must be mock outside prod
  .custom((v, helpers) =>
    v.NODE_ENV === 'production' && v.PAYMENT_MOCK_MODE !== true
      ? helpers.error('any.invalid') : v);
```

Typed accessor: `AppConfigService` wraps `ConfigService` with getters returning
already-coerced values (`get bookingTxTimeoutMs(): number`), so no
`configService.get<T>('KEY')!` string keys leak into services.

---

## 4. Idempotency (`src/common/interceptors/idempotency.interceptor.ts`)

### 4.1 Redis key

```
key    : idem:<Idempotency-Key header, uuid v4>
value  : JSON { state: 'in_progress' | 'done', bodyHash: string,
                httpStatus?: number, body?: unknown }
write  : SET key value NX EX <ttl>
         ttl = IDEMPOTENCY_INPROGRESS_TTL_S while state='in_progress' (short, ~60s);
               IDEMPOTENCY_TTL_S once rewritten as state='done'      (24h)
```

`bodyHash = sha256(canonicalJson({parentId, childId, classId, simulatePayment}))`
— `src/common/utils/hash.ts`, pure, key order fixed by an explicit field list
(not `JSON.stringify` of the raw object).

### 4.2 Algorithm (bound to `POST /bookings` only, via `@UseInterceptors`)

```
1. key = header 'Idempotency-Key'
   - missing / not uuid v4  -> throw BadRequestException(ErrorCode.Validation)  [400]
2. bodyHash = hash(request body)
3. cached = redisGet(key)              // wrapped in try/catch -> §4.3 on throw
4. cached == null:
     ok = redisSetNx(key, {state:'in_progress', bodyHash}, EX IDEMPOTENCY_INPROGRESS_TTL_S)
     ok == false:                      // HLD §6 D-Q7: someone else just claimed it
        cached = redisGet(key); goto 5
     ok == true:
        try {
          res = next.handle()          // run controller
          redisSet(key, {state:'done', bodyHash, httpStatus: res.status, body: res.body}, EX IDEMPOTENCY_TTL_S)
          return res
        } catch (e) {
          redisDel(key)                // failed attempt is retryable
          throw e
        }
5. cached.state == 'done':
     cached.bodyHash != bodyHash -> throw UnprocessableEntityException(ErrorCode.Validation)  [422]
     else -> short-circuit: return cached.httpStatus + cached.body   (handler NOT run)
6. cached.state == 'in_progress':
     cached.bodyHash != bodyHash -> 422
     else -> throw ConflictException(ErrorCode.IdempInProgress)  [409]
```

Replay of a `done` entry is byte-identical (HLD §9 test 7) because we stored the
serialized body.

### 4.3 Fail-open / fail-closed (HLD §4)

Any thrown error from an ioredis call (connection refused, timeout):

```
log.warn('idem.redis_unavailable', { requestId, key })
IDEMPOTENCY_FAIL_MODE == 'open'   -> skip cache entirely, run handler
IDEMPOTENCY_FAIL_MODE == 'closed' -> throw ServiceUnavailableException(ErrorCode.RedisClosed)  [503]
```

ioredis client: `new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1,
enableOfflineQueue: false, commandTimeout: 500 })` so a dead Redis fails fast
rather than hanging the request.

---

## 5. Repository contracts

All Prisma access for a module lives in its repository. Write methods take a
`Prisma.TransactionClient` so the whole use case is one transaction.

### 5.1 `ParentsRepository`

```ts
findByEmailWithChildren(email: string): Promise<
  (Parent & { children: Child[] }) | null
>;
```

### 5.2 `TrialClassesRepository`

```ts
// GET /trial-classes — one query, no N+1 (HLD §14)
listUpcomingWithSeatsLeft(): Promise<ClassWithSeatsLeft[]>;
//   raw: SELECT c.*, c.capacity - COALESCE(b.confirmed,0) AS seats_left
//        FROM trial_classes c
//        LEFT JOIN (SELECT class_id, COUNT(*) confirmed FROM bookings
//                   WHERE status='confirmed' GROUP BY class_id) b ON b.class_id=c.id
//        WHERE c.starts_at > now() ORDER BY c.starts_at;

findById(id: string): Promise<TrialClass | null>;

// roster
listConfirmedRoster(classId: string): Promise<RosterRow[]>;
//   SELECT ch.id, ch.name, ch.grade, b.created_at AS booked_at
//   FROM bookings b JOIN children ch ON ch.id = b.child_id
//   WHERE b.class_id = :id AND b.status = 'confirmed'
//   ORDER BY b.created_at;
```

### 5.3 `BookingsRepository`

```ts
// child + ownership check (HLD §5). Returns null if child missing OR not owned.
findOwnedChild(childId: string, parentId: string): Promise<Child | null>;
//   SELECT * FROM children WHERE id = :childId AND parent_id = :parentId

// --- transactional (tx client passed in) ---

lockClassRow(tx: Tx, classId: string): Promise<{ id: string; capacity: number; priceCents: number } | null>;
//   SELECT id, capacity, price_cents FROM trial_classes WHERE id = :classId FOR UPDATE
//   (raw query via tx.$queryRaw)

findActiveBooking(tx: Tx, childId: string, classId: string): Promise<{ id: string } | null>;
//   SELECT id FROM bookings
//   WHERE child_id=:c AND class_id=:cl AND status IN ('pending_payment','confirmed') LIMIT 1

countConfirmed(tx: Tx, classId: string): Promise<number>;
//   SELECT COUNT(*)::int FROM bookings WHERE class_id=:cl AND status='confirmed'

insertPending(tx: Tx, childId: string, classId: string, priceCents: number): Promise<{ id: string }>;
//   writes price_cents (snapshot from the locked class row);
//   catches P2002 on one_active_booking_per_child_class -> throws DuplicateBookingError (HLD §6 D-Q4)

setStatus(tx: Tx, bookingId: string, status: BookingStatus): Promise<void>;

recordPaymentAttempt(tx: Tx, input: {
  bookingId: string; result: PaymentResult; providerRef: string | null;
}): Promise<void>;

findByIdWithClass(id: string): Promise<(Booking & { trialClass: TrialClass }) | null>;
```

`Tx = Prisma.TransactionClient`.

---

## 6. The booking transaction (LLD of HLD §6)

### 6.1 Service method

```ts
// bookings.service.ts
async create(dto: CreateBookingDto, ctx: RequestContext): Promise<BookingResponseDto> {
  // 1. ownership / existence — OUTSIDE the txn (read-only, no lock needed)
  const child = await this.repo.findOwnedChild(dto.childId, dto.parentId);
  if (!child) throw new ChildNotFoundError();

  // 2. the transaction
  const result = await this.prisma.$transaction(
    async (tx) => this.runBookingTxn(tx, dto, ctx),
    { timeout: this.config.bookingTxTimeoutMs, maxWait: this.config.bookingTxTimeoutMs,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );

  this.logger.info('booking.outcome', {
    requestId: ctx.requestId, outcome: result.outcome,
    bookingId: result.bookingId, classId: dto.classId, childId: dto.childId,
    paymentRef: result.providerRef ?? undefined,
  });
  return this.mapper.toResponse(result);
}
```

### 6.2 `runBookingTxn` (private, ≤30 lines — HLD §13)

```ts
private async runBookingTxn(tx: Tx, dto: CreateBookingDto, ctx: RequestContext) {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${this.config.pgLockTimeoutMs}`);

  // step 1 — serialize competitors for THIS class
  const cls = await this.repo.lockClassRow(tx, dto.classId);
  if (!cls) throw new ClassNotFoundError();          // maps to 404 NOT_FOUND

  // step 2 — duplicate fast-path (index is the real backstop, HLD §6 D-Q4)
  if (await this.repo.findActiveBooking(tx, dto.childId, dto.classId))
    throw new DuplicateBookingError();

  // step 3 — capacity, read consistently under the lock
  const confirmed = await this.repo.countConfirmed(tx, dto.classId);
  if (confirmed >= cls.capacity) throw new ClassFullError();

  // step 4 — create pending row, snapshotting the class price (may throw
  //          DuplicateBookingError via P2002)
  const booking = await this.repo.insertPending(tx, dto.childId, dto.classId, cls.priceCents);

  // step 5 — mock payment INSIDE the txn (HLD §6/§7 — deliberate for the mock)
  const charge = await this.payment.charge({
    bookingId: booking.id, mode: dto.simulatePayment, requestId: ctx.requestId,
  });
  await this.repo.recordPaymentAttempt(tx, {
    bookingId: booking.id, result: charge.result, providerRef: charge.providerRef,
  });

  // step 6 — resolve
  const finalStatus = charge.result === PaymentResult.Success
    ? BookingStatus.Confirmed : BookingStatus.PaymentFailed;
  await this.repo.setStatus(tx, booking.id, finalStatus);

  return {
    bookingId: booking.id,
    status: finalStatus,
    outcome: charge.result === PaymentResult.Success
      ? BookingOutcome.Confirmed : BookingOutcome.PaymentFailed,
    providerRef: charge.providerRef,
    paymentResult: charge.result,
    priceCents: cls.priceCents,
  };
}
```

Note: `payment_failed` **commits** (the attempt row + the failed status are kept
for audit — HLD §3 lifecycle). Only `ClassFullError` / `DuplicateBookingError` /
`ChildNotFoundError` cause a `ROLLBACK` (thrown → Prisma rolls back).

### 6.3 `lockClassRow` raw query

```ts
const rows = await tx.$queryRaw<{ id: string; capacity: number; price_cents: number }[]>`
  SELECT id, capacity, price_cents FROM trial_classes WHERE id = ${classId}::uuid FOR UPDATE`;
const r = rows[0];
return r ? { id: r.id, capacity: Number(r.capacity), priceCents: Number(r.price_cents) } : null;
```

### 6.4 Failure-mode mapping inside the txn

| Condition | Postgres / Prisma signal | Thrown | HTTP |
|---|---|---|---|
| class id unknown | `lockClassRow` → `[]` | `ClassNotFoundError` | 404 `NOT_FOUND` |
| child unknown / not owned | pre-txn null | `ChildNotFoundError` | 404 `BOOKING_CHILD_NOT_FOUND` |
| active booking exists (fast path) | step 2 row found | `DuplicateBookingError` | 409 `BOOKING_DUPLICATE` |
| active booking race | `P2002`, target `one_active_booking_per_child_class` | `DuplicateBookingError` | 409 |
| capacity reached | `confirmed >= capacity` | `ClassFullError` | 409 `BOOKING_CLASS_FULL` |
| lock wait exceeded | PG `57014` / Prisma `P2028` w/ `lock_timeout` | `LockTimeoutError` | 503 `LOCK_TIMEOUT` (HLD §6 D-Q1) |
| payment returns `fail` | not an error | — | 200, `status: payment_failed` |

### 6.5 Sequence — last-seat race (two requests, one seat)

```mermaid
sequenceDiagram
    autonumber
    participant A as Request A
    participant B as Request B
    participant PG as Postgres (class row)
    participant Pay as MockPaymentGateway

    A->>PG: BEGIN; SELECT ... FOR UPDATE (class X)
    activate PG
    B->>PG: BEGIN; SELECT ... FOR UPDATE (class X)
    Note over B,PG: B blocks on the row lock
    A->>PG: COUNT(confirmed) = 3  (capacity 4)
    A->>PG: INSERT booking (pending)
    A->>Pay: charge()  (≈40–150 ms)
    Pay-->>A: success
    A->>PG: UPDATE booking -> confirmed
    A->>PG: COMMIT
    deactivate PG
    Note over B,PG: B acquires the lock
    B->>PG: COUNT(confirmed) = 4
    B-->>B: ClassFullError  (payment never called)
    B->>PG: ROLLBACK
```

### 6.6 `GET /trial-classes` / roster / lookup — no transaction

Plain repository reads through the non-tx client. `listUpcomingWithSeatsLeft`
uses the single JOIN query (HLD §14) — never a loop.

---

## 7. Payment gateway (`src/modules/bookings/infrastructure/`)

```ts
// payment.gateway.ts
export interface ChargeInput {
  bookingId: string;
  mode: SimulatePayment;
  requestId: string;
}
export abstract class PaymentGateway {
  abstract charge(input: ChargeInput): Promise<PaymentChargeResult>;
}
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
```

```ts
// mock-payment.gateway.ts
@Injectable()
export class MockPaymentGateway extends PaymentGateway {
  constructor(private readonly config: AppConfigService,
              private readonly logger: AppLogger) { super(); }

  async charge({ bookingId, mode, requestId }: ChargeInput): Promise<PaymentChargeResult> {
    const start = Date.now();
    await sleep(this.config.paymentMockDelayMs);          // widens the race window
    const ok =
      mode === SimulatePayment.Success ? true :
      mode === SimulatePayment.Fail    ? false :
      Math.random() >= this.config.paymentMockFailRate;   // Random

    const durationMs = Date.now() - start;
    const result = ok ? PaymentResult.Success : PaymentResult.Fail;
    const providerRef = ok ? `mock_${randomUUID()}` : null;
    this.logger.info('payment.attempt', { requestId, bookingId, result, ref: providerRef, durationMs });
    return { result, providerRef, durationMs };
  }
}
```

Bound in `BookingsModule`: `{ provide: PAYMENT_GATEWAY, useClass: MockPaymentGateway }`.
Tests inject a `FakePaymentGateway` with a settable next result.

---

## 8. DTOs & controllers

### 8.1 Request DTOs (`class-validator`, global `ValidationPipe` with
`whitelist`, `forbidNonWhitelisted`, `transform`)

```ts
// lookup-parent.dto.ts
export class LookupParentDto {
  @IsEmail() @MaxLength(320)
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email!: string;
}

// create-booking.dto.ts
export class CreateBookingDto {
  @IsUUID('4') parentId!: string;
  @IsUUID('4') childId!: string;
  @IsUUID('4') classId!: string;
  @IsOptional() @IsEnum(SimulatePayment)
  simulatePayment: SimulatePayment = SimulatePayment.Success;
}
```

`Idempotency-Key` is **not** in the DTO — it is a header, validated in the
interceptor (uuid v4, required).

Path params: `@Param('id', ParseUUIDPipe)`.

### 8.2 Response DTOs (explicit classes, no Prisma rows leak — HLD §13)

```ts
export class ParentLookupResponseDto {
  parentId!: string; name!: string;
  children!: { id: string; name: string; grade: string | null }[];
}
export class ClassResponseDto {
  id!: string; subject!: string; startsAt!: string;  // ISO
  capacity!: number; seatsLeft!: number; priceCents!: number;
}
export class BookingResponseDto {
  bookingId!: string;
  status!: 'confirmed' | 'payment_failed';
  priceCents!: number;
  payment!: { result: 'success' | 'fail' };
}
export class BookingStatusResponseDto {
  bookingId!: string; status!: BookingStatus;
  classId!: string; childId!: string; priceCents!: number; createdAt!: string;
}
export class RosterResponseDto {
  classId!: string; subject!: string;
  students!: { childId: string; name: string; grade: string | null; bookedAt: string }[];
}
```

### 8.3 Controllers (routing only)

```ts
@Controller('parents')
export class ParentsController {
  @Post('lookup') @HttpCode(200)
  lookup(@Body() dto: LookupParentDto): Promise<ParentLookupResponseDto> {
    return this.service.lookup(dto);        // 404 ParentNotFoundError if unseeded
  }
}

@Controller('trial-classes')
export class TrialClassesController {
  @Get()            list(): Promise<ClassResponseDto[]> { return this.service.listUpcoming(); }
  @Get(':id/roster') roster(@Param('id', ParseUUIDPipe) id: string): Promise<RosterResponseDto> {
    return this.service.getRoster(id);
  }
}

@Controller('bookings')
export class BookingsController {
  @Post() @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateBookingDto, @Req() req: RequestWithId): Promise<BookingResponseDto> {
    return this.service.create(dto, { requestId: req.id });
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BookingStatusResponseDto> {
    return this.service.getById(id);        // 404 if unknown
  }
}
```

`POST /bookings` returns **200** for both `confirmed` and `payment_failed`
(HLD §14). `409` bodies come from the exception filter.

---

## 9. Errors & the global filter

### 9.1 Hierarchy (`src/common/errors/`)

```ts
export abstract class DomainError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: BookingOutcome | ErrorCode;
}
class ChildNotFoundError   extends DomainError { httpStatus = 404; code = BookingOutcome.ChildNotFound; }
class ClassNotFoundError   extends DomainError { httpStatus = 404; code = ErrorCode.NotFound; }
class ParentNotFoundError  extends DomainError { httpStatus = 404; code = ErrorCode.NotFound; }
class BookingNotFoundError extends DomainError { httpStatus = 404; code = ErrorCode.NotFound; }
class DuplicateBookingError extends DomainError { httpStatus = 409; code = BookingOutcome.Duplicate; }
class ClassFullError       extends DomainError { httpStatus = 409; code = BookingOutcome.ClassFull; }
class LockTimeoutError     extends DomainError { httpStatus = 503; code = ErrorCode.LockTimeout; }
```

### 9.2 `AllExceptionsFilter` (`APP_FILTER`, global)

```
catch(exception):
  requestId  = request.id
  durationMs = now - request.startTime
  route      = request.route?.path ?? request.url          // pattern, e.g. GET /bookings/:id

  if exception instanceof DomainError:
     status = exception.httpStatus; code = exception.code
     log.warn('request.error', { requestId, route, statusCode: status, durationMs,
                                 errorName: exception.name, outcome: code })
  else if exception instanceof HttpException:               // validation pipe, ParseUUIDPipe, etc.
     status = exception.getStatus()
     code   = mapHttpToCode(status)     // 400->VALIDATION_ERROR (or as thrown), 422->VALIDATION_ERROR, 404->NOT_FOUND
     log.warn('request.error', { ... })
  else if isPrismaLockTimeout(exception):                   // P2028 / 57014
     status = 503; code = ErrorCode.LockTimeout
     log.error('request.error', { ..., errorName: 'LockTimeout' })
  else:
     status = 500; code = ErrorCode.Internal
     log.error('request.error', { requestId, route, statusCode: 500, durationMs,
                                  errorName: exception.name, stack: exception.stack })

  response.status(status).json({ error: code, message: messageFor(code), requestId })
```

`messageFor` — a small map to the user-facing strings in HLD §12
(`BOOKING_CLASS_FULL → "Sorry, that seat was just taken."` etc.).

### 9.3 `RequestLoggingInterceptor` (`APP_INTERCEPTOR`, global)

- `beforeHandle`: `request.id = randomUUID()`, `request.startTime = Date.now()`.
- `afterHandle` (success): `log.info('http.response', { requestId, method, route,
  statusCode, durationMs })`. 4xx→warn, 5xx→error handled by the filter instead
  (filter owns error responses).

---

## 10. Logging interface (`src/common/logger/`)

```ts
export abstract class AppLogger {
  abstract info(event: string, context: Record<string, unknown>): void;
  abstract warn(event: string, context: Record<string, unknown>): void;
  abstract error(event: string, context: Record<string, unknown>): void;
  abstract debug(event: string, context: Record<string, unknown>): void;
}

@Injectable()
export class ConsoleLogger extends AppLogger {
  info(event, context)  { this.write('info', event, context); }
  // ...
  private write(level: string, event: string, context: Record<string, unknown>) {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...context }) + '\n');
  }
}
```

Event catalogue = HLD §13 table. `LoggerModule` is `@Global`, binds
`{ provide: AppLogger, useClass: ConsoleLogger }`.

---

## 11. Module wiring

```mermaid
graph TD
  App[AppModule] --> Cfg[ConfigModule isGlobal]
  App --> Prisma[PrismaModule @Global]
  App --> Redis[RedisModule @Global]
  App --> Log[LoggerModule @Global]
  App --> Parents[ParentsModule]
  App --> Classes[TrialClassesModule]
  App --> Bookings[BookingsModule]
  App -. APP_INTERCEPTOR .-> RLI[RequestLoggingInterceptor]
  App -. APP_FILTER .-> AEF[AllExceptionsFilter]
  App -. APP_PIPE .-> VP[ValidationPipe]
  Bookings --> PG[PAYMENT_GATEWAY = MockPaymentGateway]
  Bookings --> IdemInt[IdempotencyInterceptor route-scoped]
  Parents --> Prisma
  Classes --> Prisma
  Bookings --> Prisma
  IdemInt --> Redis
```

Domain modules import only `PrismaModule` implicitly (global) — no module imports
another domain module's service (HLD §13).

### 11.1 `main.ts`

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
  transform: true, transformOptions: { enableImplicitConversion: false } }));
app.enableCors({ origin: config.corsOrigin });
app.enableShutdownHooks();                 // Prisma + Redis clean disconnect
await app.listen(config.port);
```

`PrismaService` — `onModuleInit` connects, `enableShutdownHooks` disconnects.
`DATABASE_URL` carries `?connection_limit=${PG_POOL_SIZE}`.

---

## 12. Seed (`prisma/seed.ts` + `prisma/seed-constants.ts`)

```ts
// seed-constants.ts — imported by seed, e2e specs, and the frontend demo
export const IDS = {
  parentAlice:  '00000000-0000-4000-8000-000000000001',
  parentBob:    '00000000-0000-4000-8000-000000000002',
  childAmy:     '00000000-0000-4000-8000-000000000011', // Alice's
  childBen:     '00000000-0000-4000-8000-000000000012', // Alice's
  childCleo:    '00000000-0000-4000-8000-000000000013', // Bob's
  childDan:     '00000000-0000-4000-8000-000000000014', // Bob's
  classOpen:    '00000000-0000-4000-8000-000000000021', // A: 1 confirmed, 3 free
  classLastSeat:'00000000-0000-4000-8000-000000000022', // B: 3 confirmed, 1 free
  classFull:    '00000000-0000-4000-8000-000000000023', // C: 4 confirmed
} as const;
```

Seed logic (all `upsert` by id so re-running resets — HLD §8, §14):

| Row set | Content |
|---|---|
| parents | Alice, Bob (fixed emails `alice@example.com`, `bob@example.com`) |
| children | Amy, Ben → Alice; Cleo, Dan → Bob |
| classes | A `subject:"Math"` +7d `price_cents 2500`, B `"Science"` +8d `3000`, C `"Coding"` +9d `2000`, all `capacity 4`, `startsAt` in the future |
| bookings — A | Amy `confirmed` (⇒ re-booking Amy into A = `DUPLICATE_BOOKING`; 3 seats left) |
| bookings — B | Ben, Cleo, Dan `confirmed` (⇒ 1 seat left, the race target) |
| bookings — C | Amy, Ben, Cleo, Dan `confirmed` (⇒ full; overbooking-rejection target) |
| every seeded booking | `price_cents` copied from its class |
| payment_attempts | one `success` row per seeded confirmed booking |

`package.json`: `"prisma": { "seed": "ts-node prisma/seed.ts" }`; scripts
`db:reset` = `prisma migrate reset --force` (runs seed), `db:seed` =
`prisma db seed`.

> Note: seeding Amy `confirmed` in both A and C is fine — different classes,
> the partial unique index is per `(child_id, class_id)`.

---

## 13. Test plan (LLD of HLD §9)

### 13.1 Layout

```
src/**/*.spec.ts            unit — mocked repo + FakePaymentGateway + fake Redis
test/
  jest-e2e.setup.ts         global: prisma migrate deploy on test DB (once)
  helpers/
    reset-db.ts             TRUNCATE ... RESTART IDENTITY CASCADE; re-run seed
    app-factory.ts          Test.createTestingModule -> Nest app + supertest
  bookings.e2e-spec.ts      HLD §9 scenarios 1–6
  idempotency.e2e-spec.ts   HLD §9 scenarios 7–8
```

`jest.config.ts` — two projects: `unit` (`testMatch **/*.spec.ts`, no setup) and
`e2e` (`testMatch test/**/*.e2e-spec.ts`, `globalSetup`, `maxWorkers: 1` so e2e
specs don't fight over the DB).

### 13.2 Unit specs — key assertions

| File | Assertions |
|---|---|
| `bookings.service.spec.ts` | child not found → `ChildNotFoundError`, `$transaction` never called; repo `countConfirmed` ≥ capacity → `ClassFullError`, `payment.charge` **not** called; gateway `fail` → status `payment_failed`, `setStatus(PaymentFailed)`, still commits; gateway `success` → `confirmed`; `insertPending` throws P2002 → `DuplicateBookingError`; the class `priceCents` is passed to `insertPending` and echoed in the response |
| `booking.policy.spec.ts` | `canRetry('payment_failed') === true`; `canRetry('confirmed') === false`; `canRetry('pending_payment') === false` |
| `seat.policy.spec.ts` | `seatsLeft(4,4) === 0`; `seatsLeft(4,1) === 3`; `seatsLeft(4,5) === 0` (clamp) |
| `mock-payment.gateway.spec.ts` | `success`→result success + non-null ref; `fail`→fail + null ref; `random` with failRate 1 → fail, 0 → success; waits ≥ delay |
| `idempotency.interceptor.spec.ts` | miss → handler runs + `SET` called with `done`; hit `done` → cached body returned, handler not called; hit `in_progress` same hash → 409; `done` different hash → 422; redis `get` throws + mode open → handler runs; mode closed → 503; `SETNX` returns 0 → re-GET path (HLD §6 D-Q7) |
| `hash.spec.ts` | field-order independent; different `simulatePayment` → different hash |
| mappers | internal columns (`updatedAt`, raw status enums where not wanted) absent |

### 13.3 e2e specs

| # | Spec | Setup | Assert |
|---|---|---|---|
| 1 | happy path | seed | `POST /bookings` {childBen? use a free child, classOpen} → 200 `confirmed`; roster of A grows by 1; `GET /bookings/:id` → `confirmed` |
| 2 | duplicate | seed | book {childAmy, classOpen} → 409 `BOOKING_DUPLICATE`; `bookings` count unchanged |
| 3 | overbooking | seed | book into `classFull` → 409 `BOOKING_CLASS_FULL`; **no** new `payment_attempts` row |
| 4 | payment failure | seed | book {free child, classOpen, simulatePayment:'fail'} → 200 `payment_failed`; roster unchanged; one `payment_attempts` row `fail` |
| 5 | **last-seat race** | seed (`classLastSeat`, 1 seat) | fire N=20 `POST /bookings` for **distinct** children (need ≥20 seeded children OR relax the duplicate rule for the test by using distinct throwaway children created in setup) via `Promise.all`; assert **exactly one** 200 `confirmed`, the rest 409 `BOOKING_CLASS_FULL`, zero 5xx; `SELECT COUNT(*) confirmed WHERE class=B` === 4 |
| 6 | retry after failure | run #4 first | same child + class again with `simulatePayment:'success'` → 200 `confirmed` |
| 7 | idempotency | seed | same `Idempotency-Key` + body twice → one booking row, 2nd response byte-identical; same key + different body → 422 |
| 8 | redis down | `docker compose stop redis` in the spec (or point client at a dead port) | booking still 200; naive retry (same key) → 409 `BOOKING_DUPLICATE` (documented degradation); roster shows exactly one row |

**Race spec detail (HLD §6 D-Q1):** test env sets `PAYMENT_MOCK_DELAY_MS=40`,
`BOOKING_TX_TIMEOUT_MS=15000`, `PG_LOCK_TIMEOUT_MS=10000`, `connection_limit=30`. Seed a
setup helper that inserts 25 disposable children under one parent so each
concurrent request targets a distinct child (keeps the *duplicate* rule out of
the way; the thing under test is *capacity*).

### 13.4 Docker (`docker-compose.test.yml` overlay — HLD §14)

```yaml
services:
  postgres-test:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: ottodot, POSTGRES_PASSWORD: ottodot, POSTGRES_DB: ottodot_test }
    ports: ["5433:5432"]
    tmpfs: ["/var/lib/postgresql/data"]        # no volume — fast, disposable
  redis-test:
    image: redis:7-alpine
    ports: ["6380:6379"]
```

Test `DATABASE_URL=postgresql://ottodot:ottodot@localhost:5433/ottodot_test?schema=public&connection_limit=30`,
`REDIS_URL=redis://localhost:6380`.

---

## 14. Build order (concrete checklist — expands HLD §14)

0. **Starting point.** The repo currently holds only the default `nest new`
   scaffold: `src/app.{controller,service,module}.ts`, `src/app.controller.spec.ts`,
   `test/app.e2e-spec.ts`. Delete the boilerplate `AppController`/`AppService` and
   both scaffold spec files; keep `app.module.ts` (rework it per §11.1) and
   `main.ts`. No domain code or real tests exist yet — everything in §13 is
   written from scratch.
1. **Scaffold** — strip to essentials, add `tsconfig` `strict`,
   `oxlint`/`prettier`, `jest.config.ts` (two projects: `unit`, `e2e`).
   Add a `GET /health` handler (a tiny `HealthController`, no `AppService`).
2. **Prisma** — `schema.prisma` (§2) → `migrate dev --create-only` → hand-add
   `citext` extension + partial unique index + capacity check (§2.1) →
   `migrate dev` → `seed-constants.ts` + `seed.ts` (§12).
3. **common/** — `config` (§3), `PrismaModule`/`PrismaService`, `RedisModule`
   (ioredis, lazy, fail-fast), `LoggerModule` (§10), enums (§1.2), `DomainError`
   + subclasses (§9.1), `AllExceptionsFilter` (§9.2), `RequestLoggingInterceptor`
   (§9.3), `hash.ts` / `time.ts`.
4. **bookings module** — `BookingsRepository` (§5.3, incl. `lockClassRow`,
   `insertPending` P2002 mapping) → `PaymentGateway` + `MockPaymentGateway` (§7)
   → `BookingsService` (`create` + `runBookingTxn` + `getById`, §6) → `mapper` +
   `booking.policy` → `BookingsController` (§8.3).
5. **IdempotencyInterceptor** (§4) — wire to `POST /bookings` only.
6. **trial-classes module** — repository (JOIN query + roster), service
   (`listUpcoming`, `getRoster`), `seat.policy`, controller.
7. **parents module** — repository (`findByEmailWithChildren`), service
   (`lookup` → `ParentNotFoundError`), mapper, controller.
8. **Unit specs** alongside each file as it lands (§13.2).
9. **e2e** — `docker-compose.test.yml`, `jest-e2e.setup.ts`, `reset-db.ts`,
   `app-factory.ts`, then scenarios 1–8 (§13.3). Race spec last.
10. **Frontend** (§16, HLD §12) — `web/`, Vite React-TS, 3 views + the
    concurrent-fire demo button.
11. **Dockerfile** (multi-stage, non-root, `CMD prisma migrate deploy && node dist/main.js`),
    `.dockerignore`, `docker-compose.yml`, README run steps, finalize
    `AI-usage.md` (repo root).

---

## 15. Traceability — HLD invariant → LLD mechanism

| HLD invariant | LLD mechanism | Test |
|---|---|---|
| No duplicate confirmed booking | fast-path check §6.2 step 2 + partial unique index §2.1 + P2002 mapping §5.3/§6.4 | e2e #2, #7 |
| No overbooking beyond capacity | `FOR UPDATE` §6.3 + `countConfirmed` under lock §6.2 step 3 | e2e #3, #5 |
| Payment failure never confirms | `setStatus` only to `Confirmed` on success branch §6.2 step 6 | unit `bookings.service`, e2e #4 |
| Last-seat race → ≤1 confirmed | class-row lock serializes; loser rejected pre-payment §6.2/§6.5 | e2e #5 |
| Retried HTTP call → replay | `IdempotencyInterceptor` §4.2 | e2e #7 |
| Correctness independent of Redis | fail-open §4.3; DB constraints stand alone | e2e #8 |
| Roster = confirmed only | `listConfirmedRoster` `WHERE status='confirmed'` §5.2 | e2e #1, #4 |
| No auth can't overbook | server checks vs class row, not caller identity §6 | covered by #5 (spoofable ids irrelevant) |

---

## 16. Frontend (LLD of HLD §12)

Deliberately minimal — its only job is to make the invariants (payment failure,
last-seat race) **visible** for the walkthrough video. React so the reviewer sees
component state + async handling (it's a full-stack role); everything else cut.

### 16.1 Stack & location

- **`web/`** at repo root, its **own `package.json`** (deps never mix with the
  Nest app). Not an npm workspace — just a sibling folder.
- **Vite + React + TypeScript**: `npm create vite@latest web -- --template react-ts`.
- **No** router, component library, state-management lib, CSS framework, or
  data-fetching lib. `useState` / `useEffect` + `fetch` only.
- One `<style>` block or a single `index.css` — plain, unstyled-but-readable.

### 16.2 Directory layout

```
web/
  index.html
  package.json
  vite.config.ts            # server.proxy '/api' -> VITE_PROXY_TARGET (dev)
  .env.example              # VITE_API_BASE=/api, VITE_PROXY_TARGET=http://localhost:3000
  Dockerfile               # build -> nginx static + /api proxy (compose `web` service)
  nginx.conf
  src/
    main.tsx                # ReactDOM.createRoot
    styles.css              # minimal, theme-agnostic
    api.ts                  # typed fetch wrappers + ApiError + formatPrice + newIdempotencyKey
    App.tsx                 # `view` + session state; ParentView / ReviewView /
                            #   ResultView / RosterView components in one file
                            #   (small enough not to split; matches "minimal")
```

`ReviewView` is the checkout/confirmation step (child · class · date · price →
"Confirm & pay"); `ParentView` also carries the dev `simulatePayment` toggle and
the "fire concurrent bookings" race-demo button.

### 16.3 `api.ts` — the only place `fetch` is called

```ts
const BASE = import.meta.env.VITE_API_BASE ?? '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error, body?.message);
  return body as T;
}

export const api = {
  lookupParent: (email: string) =>
    req<ParentLookupResponse>('/parents/lookup', {
      method: 'POST', body: JSON.stringify({ email }),
    }),
  listClasses: () => req<ClassResponse[]>('/trial-classes'),
  getRoster: (classId: string) =>
    req<RosterResponse>(`/trial-classes/${classId}/roster`),
  createBooking: (input: CreateBookingInput, idempotencyKey: string) =>
    req<BookingResponse>('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      // send ONLY {parentId, childId, classId, simulatePayment} — the API's
      // ValidationPipe is forbidNonWhitelisted, so any extra key → 422
      body: JSON.stringify({
        parentId: input.parentId, childId: input.childId,
        classId: input.classId, simulatePayment: input.simulatePayment,
      }),
    }),
  getBooking: (id: string) => req<BookingStatusResponse>(`/bookings/${id}`),
};

// price is stored in minor units (HLD §3); format at the edge
export const formatPrice = (cents: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);

export class ApiError extends Error {
  constructor(public status: number, public code?: string, message?: string) {
    super(message ?? code ?? `HTTP ${status}`);
  }
}
```

### 16.4 `App.tsx` state (all of it)

```ts
type View = 'parent' | 'review' | 'result' | 'roster';

const [view, setView]       = useState<View>('parent');
const [parent, setParent]   = useState<ParentLookupResponse | null>(null); // session, no token
const [classes, setClasses] = useState<ClassResponse[]>([]);
const [attempt, setAttempt] = useState<Attempt | null>(null);   // child+class+price+sim, set on "Review & book"
const [lastResult, setLastResult] =
  useState<{ ok: true; data: BookingResponse } | { ok: false; err: ApiError } | null>(null);
```

`parent` view collects child + class; **"Review & book"** stashes the selection
(incl. the class `priceCents`) into `attempt` and switches to the `review` view.
`review` shows child / class / date / **price** and a "Confirm & pay {price}"
button — *that* is what calls `createBooking` (fresh `Idempotency-Key`), then
switches to `result`. No request is sent until the user confirms on the review
screen.

- `parent` is the whole lookup response held in memory — **no token, no
  storage**. Refresh = start over (matches "identify, not auth", HLD §4).
- `classes` refetched on entering View 1b and after any booking (so `seatsLeft`
  updates).

### 16.5 Booking-result mapping (View 2) — mirrors HLD §12

| Input | Message |
|---|---|
| `200` `status: 'confirmed'` | "Booked — {child} is confirmed for {class}. Charged {price}." (price from `data.priceCents`) |
| `200` `status: 'payment_failed'` | "Payment didn't go through." + **Retry** button (re-arms a new `Idempotency-Key`) |
| `ApiError` `code: 'BOOKING_CLASS_FULL'` | "Sorry, that seat was just taken." |
| `ApiError` `code: 'BOOKING_DUPLICATE'` | "You already have a booking for this class." |
| `ApiError` `code: 'VALIDATION_ERROR'` | "Please pick a child and a class." |
| `ApiError` `status: 503` (`LOCK_TIMEOUT` / dependency) | "Busy right now — try again in a moment." |
| anything else | "Something went wrong. Try again." |

Switch on `err.code` (the `BookingOutcome` string), not on HTTP status alone.

### 16.6 Idempotency key handling

`lib/idempotencyKey.ts`: `export const newIdempotencyKey = () => crypto.randomUUID()`.

- `BookingForm` generates **one key when the Book button is armed** (component
  mount / form reset), stores it in a `useRef`, sends it on submit, and
  **disables the button** while the request is in flight.
- **Retry after `payment_failed`** generates a **fresh** key (it's a new attempt —
  HLD §6: retry creates a new booking row).
- A user who double-clicks before the disable lands sends the *same* key twice →
  server replays the first response (HLD §4). This is the visible payoff of the
  idempotency layer; worth showing in the video.

### 16.7 `RaceDemo.tsx` — the money shot for the video

```ts
// dev-only affordance. Cap N low (≈6) so queued lock waits stay under
// PG_LOCK_TIMEOUT_MS with the 150ms mock delay (HLD §6 D-Q1 / §12).
async function fireConcurrent(input: CreateBookingInput, n: number) {
  const attempts = Array.from({ length: n }, () =>
    api.createBooking(input, newIdempotencyKey())      // distinct key each
      .then(data => ({ ok: true as const, data }))
      .catch((err: ApiError) => ({ ok: false as const, err })));
  return Promise.all(attempts);                        // render every outcome
}
```

Renders a list: exactly one `confirmed`, the rest `BOOKING_CLASS_FULL` (or
`BOOKING_DUPLICATE` if the same child is reused — use **distinct** seeded
children, HLD §12). Each request uses a distinct child + distinct idempotency
key so the only thing under test is capacity.

### 16.8 Running it

```bash
cd web
cp .env.example .env          # VITE_API_BASE=/api  (proxied to :3000 by vite)
npm install
npm run dev                   # http://localhost:5173
```

The API must be running (README Option A or B). `vite.config.ts` proxies
`/api/*` → `http://localhost:3000` in dev, so no CORS in normal use; the API's
`CORS_ORIGIN=http://localhost:5173` covers the case where the frontend calls the
API directly. `npm run build` emits static assets to `web/dist/` (not wired into
the Docker image — out of scope; serve with any static host or `vite preview`).

### 16.9 Cut (HLD §12)

Styling beyond minimal CSS, spinners, routing, auth screens, responsive layout,
client validation past "child + class selected", parent sign-up, persisting the
session across refresh.
