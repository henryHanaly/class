import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { IDS } from '../prisma/seed-constants';
import { createE2eApp, E2eContext } from './helpers/app-factory';
import { resetDb } from './helpers/reset-db';

// HLD §9 scenarios 1–6 — real Postgres (docker-compose.test.yml).
describe('Bookings (e2e)', () => {
  let ctx: E2eContext;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ctx = await createE2eApp();
    prisma = ctx.prisma;
  });
  afterAll(() => ctx.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(ctx.app.getHttpServer());
  const idemKey = () => ({ 'Idempotency-Key': randomUUID() });

  async function makeChild(name = 'Temp'): Promise<string> {
    const child = await prisma.child.create({
      data: { parentId: IDS.parentAlice, name },
    });
    return child.id;
  }

  const book = (body: Record<string, unknown>) =>
    http().post('/bookings').set(idemKey()).send(body);

  it('1 — happy path: books into an open class and grows the roster', async () => {
    const res = await book({
      parentId: IDS.parentAlice,
      childId: IDS.childBen,
      classId: IDS.classOpen,
      simulatePayment: 'success',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'confirmed' });

    const roster = await http().get(`/trial-classes/${IDS.classOpen}/roster`);
    expect(roster.body.students).toHaveLength(2); // Amy (seed) + Ben

    const status = await http().get(`/bookings/${res.body.bookingId}`);
    expect(status.body.status).toBe('confirmed');
  });

  it('2 — duplicate: same child + class while confirmed → 409, no new row', async () => {
    const before = await prisma.booking.count();
    const res = await book({
      parentId: IDS.parentAlice,
      childId: IDS.childAmy,
      classId: IDS.classOpen,
      simulatePayment: 'success',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BOOKING_DUPLICATE');
    expect(await prisma.booking.count()).toBe(before);
  });

  it('3 — overbooking: booking a full class → 409, no payment attempt', async () => {
    const childId = await makeChild('Full-tester');
    const before = await prisma.paymentAttempt.count();

    const res = await book({
      parentId: IDS.parentAlice,
      childId,
      classId: IDS.classFull,
      simulatePayment: 'success',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('BOOKING_CLASS_FULL');
    expect(await prisma.paymentAttempt.count()).toBe(before);
  });

  it('4 — payment failure: seat stays free, roster unchanged, one fail attempt', async () => {
    const childId = await makeChild('Fail-tester');

    const res = await book({
      parentId: IDS.parentAlice,
      childId,
      classId: IDS.classOpen,
      simulatePayment: 'fail',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('payment_failed');

    const roster = await http().get(`/trial-classes/${IDS.classOpen}/roster`);
    expect(roster.body.students).toHaveLength(1); // only seeded Amy
    const attempts = await prisma.paymentAttempt.count({
      where: { result: 'fail' },
    });
    expect(attempts).toBe(1);
  });

  it('5 — last-seat race: exactly one confirmed, the rest CLASS_FULL', async () => {
    const N = 20;
    const children = await Promise.all(
      Array.from({ length: N }, (_, i) => makeChild(`Racer-${i}`)),
    );

    const results = await Promise.all(
      children.map((childId) =>
        book({
          parentId: IDS.parentAlice,
          childId,
          classId: IDS.classLastSeat,
          simulatePayment: 'success',
        }),
      ),
    );

    const confirmed = results.filter((r) => r.status === 200);
    const full = results.filter(
      (r) => r.status === 409 && r.body.error === 'BOOKING_CLASS_FULL',
    );
    expect(confirmed).toHaveLength(1);
    expect(full).toHaveLength(N - 1);
    expect(results.some((r) => r.status >= 500)).toBe(false);

    const count = await prisma.booking.count({
      where: { classId: IDS.classLastSeat, status: 'confirmed' },
    });
    expect(count).toBe(4); // capacity
  });

  it('6 — retry after failure: same child + class can succeed next time', async () => {
    const childId = await makeChild('Retry-tester');
    const failed = await book({
      parentId: IDS.parentAlice,
      childId,
      classId: IDS.classOpen,
      simulatePayment: 'fail',
    });
    expect(failed.body.status).toBe('payment_failed');

    const retry = await book({
      parentId: IDS.parentAlice,
      childId,
      classId: IDS.classOpen,
      simulatePayment: 'success',
    });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('confirmed');
  });
});
