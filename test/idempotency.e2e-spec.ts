import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { IDS } from '../prisma/seed-constants';
import { createE2eApp, E2eContext } from './helpers/app-factory';
import { resetDb } from './helpers/reset-db';

// HLD §9 scenarios 7–8.
describe('Idempotency (e2e)', () => {
  let ctx: E2eContext;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ctx = await createE2eApp();
    prisma = ctx.prisma;
  });
  afterAll(() => ctx.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(ctx.app.getHttpServer());

  it('7 — same key + body twice → one booking, identical replayed response', async () => {
    const key = randomUUID();
    const body = {
      parentId: IDS.parentAlice,
      childId: IDS.childBen,
      classId: IDS.classOpen,
      simulatePayment: 'success',
    };

    const first = await http().post('/bookings').set('Idempotency-Key', key).send(body);
    const second = await http().post('/bookings').set('Idempotency-Key', key).send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const count = await prisma.booking.count({
      where: { childId: IDS.childBen, classId: IDS.classOpen },
    });
    expect(count).toBe(1);
  });

  it('7b — same key + different body → 422', async () => {
    const key = randomUUID();
    await http()
      .post('/bookings')
      .set('Idempotency-Key', key)
      .send({
        parentId: IDS.parentAlice,
        childId: IDS.childBen,
        classId: IDS.classOpen,
        simulatePayment: 'success',
      });

    const reused = await http()
      .post('/bookings')
      .set('Idempotency-Key', key)
      .send({
        parentId: IDS.parentAlice,
        childId: IDS.childBen,
        classId: IDS.classOpen,
        simulatePayment: 'fail',
      });

    expect(reused.status).toBe(422);
  });

  // Scenario 8 (Redis down, fail-open) — run with Redis stopped:
  //   docker compose -f docker-compose.yml -f docker-compose.test.yml stop redis
  it.skip('8 — Redis down: booking still succeeds, naive retry → 409 DUPLICATE', async () => {
    const key = randomUUID();
    const body = {
      parentId: IDS.parentAlice,
      childId: IDS.childBen,
      classId: IDS.classOpen,
      simulatePayment: 'success',
    };
    const first = await http().post('/bookings').set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(200);

    const retry = await http().post('/bookings').set('Idempotency-Key', key).send(body);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe('BOOKING_DUPLICATE');

    const count = await prisma.booking.count({
      where: { childId: IDS.childBen, classId: IDS.classOpen, status: 'confirmed' },
    });
    expect(count).toBe(1);
  });
});
