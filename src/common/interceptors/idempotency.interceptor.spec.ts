import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { bodyHash } from '../utils/hash';

const KEY = '11111111-1111-4111-8111-111111111111';
const BODY = {
  parentId: 'p1',
  childId: 'c1',
  classId: 'cl1',
  simulatePayment: 'success',
};
const HASH = bodyHash(BODY);

function makeCtx(headerValue: string | undefined, body: unknown = BODY) {
  const req = {
    id: 'req-1',
    body,
    header: (name: string) =>
      name.toLowerCase() === 'idempotency-key' ? headerValue : undefined,
  };
  const res = { statusCode: 200 };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
}

function makeHandler(value: unknown, spy = jest.fn()) {
  return {
    handle: () => {
      spy();
      return of(value);
    },
    spy,
  };
}

function setup(failMode: 'open' | 'closed' = 'open') {
  const redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const config = {
    idempotencyTtlS: 86400,
    idempotencyInProgressTtlS: 60,
    idempotencyFailMode: failMode,
  } as never;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const interceptor = new IdempotencyInterceptor(
    redis as never,
    config,
    logger as never,
  );
  return { interceptor, redis, logger };
}

async function invoke(
  interceptor: IdempotencyInterceptor,
  ctx: unknown,
  handler: { handle: () => unknown },
): Promise<unknown> {
  const obs = await interceptor.intercept(ctx as never, handler as never);
  return firstValueFrom(obs as never);
}

describe('IdempotencyInterceptor', () => {
  it('rejects a missing / malformed Idempotency-Key with 400', async () => {
    const { interceptor } = setup();
    await expect(
      invoke(interceptor, makeCtx(undefined), makeHandler({})),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      invoke(interceptor, makeCtx('not-a-uuid'), makeHandler({})),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('on a miss: runs the handler and caches the result as done', async () => {
    const { interceptor, redis } = setup();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValueOnce('OK'); // claim
    redis.set.mockResolvedValueOnce('OK'); // store
    const handler = makeHandler({ bookingId: 'b1' });

    const result = await invoke(interceptor, makeCtx(KEY), handler);

    expect(result).toEqual({ bookingId: 'b1' });
    expect(handler.spy).toHaveBeenCalledTimes(1);
    const storeCall = redis.set.mock.calls[1];
    expect(storeCall[0]).toBe(`idem:${KEY}`);
    expect(JSON.parse(storeCall[1] as string)).toMatchObject({
      state: 'done',
      httpStatus: 200,
      body: { bookingId: 'b1' },
    });
  });

  it('on a done hit with matching hash: replays without running the handler', async () => {
    const { interceptor, redis } = setup();
    redis.get.mockResolvedValue(
      JSON.stringify({
        state: 'done',
        bodyHash: HASH,
        httpStatus: 200,
        body: { bookingId: 'cached' },
      }),
    );
    const handler = makeHandler({ bookingId: 'fresh' });

    const result = await invoke(interceptor, makeCtx(KEY), handler);

    expect(result).toEqual({ bookingId: 'cached' });
    expect(handler.spy).not.toHaveBeenCalled();
  });

  it('on an in_progress hit with matching hash: 409', async () => {
    const { interceptor, redis } = setup();
    redis.get.mockResolvedValue(
      JSON.stringify({ state: 'in_progress', bodyHash: HASH }),
    );
    await expect(
      invoke(interceptor, makeCtx(KEY), makeHandler({})),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('on a done hit with a different body hash: 422 (key reuse)', async () => {
    const { interceptor, redis } = setup();
    redis.get.mockResolvedValue(
      JSON.stringify({ state: 'done', bodyHash: 'other', body: {} }),
    );
    await expect(
      invoke(interceptor, makeCtx(KEY), makeHandler({})),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('on an in_progress hit with a different body hash: 422 (key reuse wins over 409)', async () => {
    const { interceptor, redis } = setup();
    redis.get.mockResolvedValue(
      JSON.stringify({ state: 'in_progress', bodyHash: 'other' }),
    );
    await expect(
      invoke(interceptor, makeCtx(KEY), makeHandler({})),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('SETNX losing the claim falls back to replaying the winner’s result', async () => {
    const { interceptor, redis } = setup();
    redis.get
      .mockResolvedValueOnce(null) // first GET: miss
      .mockResolvedValueOnce(
        JSON.stringify({
          state: 'done',
          bodyHash: HASH,
          httpStatus: 200,
          body: { bookingId: 'winner' },
        }),
      );
    redis.set.mockResolvedValueOnce(null); // NX claim lost
    const handler = makeHandler({ bookingId: 'loser' });

    const result = await invoke(interceptor, makeCtx(KEY), handler);

    expect(result).toEqual({ bookingId: 'winner' });
    expect(handler.spy).not.toHaveBeenCalled();
  });

  it('fails open when Redis throws: runs the handler anyway', async () => {
    const { interceptor, redis, logger } = setup('open');
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const handler = makeHandler({ bookingId: 'b1' });

    const result = await invoke(interceptor, makeCtx(KEY), handler);

    expect(result).toEqual({ bookingId: 'b1' });
    expect(handler.spy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'idem.redis_unavailable',
      expect.objectContaining({ key: KEY }),
    );
  });

  it('hashes an absent request body as an empty object', async () => {
    const { interceptor, redis } = setup();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const req = {
      id: 'req-1',
      body: undefined,
      header: (n: string) =>
        n.toLowerCase() === 'idempotency-key' ? KEY : undefined,
    };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ statusCode: 200 }),
      }),
    };

    await invoke(interceptor, ctx, makeHandler({ ok: true }));

    expect(JSON.parse(redis.set.mock.calls[0][1] as string).bodyHash).toBe(
      bodyHash({}),
    );
  });

  it('retries from scratch when the claim is lost but the entry then vanishes', async () => {
    const { interceptor, redis } = setup();
    redis.get
      .mockResolvedValueOnce(null) // initial miss
      .mockResolvedValueOnce(null) // after losing claim: entry gone
      .mockResolvedValueOnce(null); // recursion: miss again
    redis.set
      .mockResolvedValueOnce(null) // first claim lost
      .mockResolvedValueOnce('OK') // recursion claim won
      .mockResolvedValueOnce('OK'); // store
    const handler = makeHandler({ bookingId: 'b1' });

    const result = await invoke(interceptor, makeCtx(KEY), handler);

    expect(result).toEqual({ bookingId: 'b1' });
    expect(handler.spy).toHaveBeenCalledTimes(1);
  });

  it('discards the in-progress entry when the handler throws, then rethrows', async () => {
    const { interceptor, redis } = setup();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValueOnce('OK'); // claim
    redis.del.mockResolvedValue(1);
    const boom = new Error('handler failed');
    const { throwError } = jest.requireActual('rxjs') as typeof import('rxjs');

    await expect(
      invoke(interceptor, makeCtx(KEY), { handle: () => throwError(() => boom) }),
    ).rejects.toBe(boom);
    expect(redis.del).toHaveBeenCalledWith(`idem:${KEY}`);
  });

  it('swallows a Redis failure raised while discarding', async () => {
    const { interceptor, redis } = setup();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValueOnce('OK');
    redis.del.mockRejectedValue(new Error('redis down'));
    const boom = new Error('handler failed');
    const { throwError } = jest.requireActual('rxjs') as typeof import('rxjs');

    await expect(
      invoke(interceptor, makeCtx(KEY), { handle: () => throwError(() => boom) }),
    ).rejects.toBe(boom);
  });

  it('fails closed when configured: 503', async () => {
    const { interceptor, redis } = setup('closed');
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      invoke(interceptor, makeCtx(KEY), makeHandler({})),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
