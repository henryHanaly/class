import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { Observable, catchError, concatMap, from, of, throwError } from 'rxjs';
import { AppConfigService } from '../config/app-config.service';
import { ErrorCode } from '../enums/error-code.enum';
import { AppLogger } from '../logger/app-logger';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { RequestWithId } from '../request-context';
import { bodyHash } from '../utils/hash';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface IdemEntry {
  state: 'in_progress' | 'done';
  bodyHash: string;
  httpStatus?: number;
  body?: unknown;
}

// HLD §4 / LLD §4.2 — bound to POST /bookings only. Replays a completed attempt
// byte-for-byte; rejects an in-flight duplicate; fails open (or closed) when
// Redis is unreachable so correctness never depends on it.
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<RequestWithId>();
    const key = this.readKey(req);
    const hash = bodyHash(req.body ?? {});

    let cached: IdemEntry | null;
    try {
      cached = await this.get(key);
    } catch (err) {
      return this.onRedisDown(req, key, err, next);
    }

    if (!cached) return this.claimAndRun(context, next, key, hash);
    return this.replay(cached, hash);
  }

  private readKey(req: RequestWithId): string {
    const key = req.header('Idempotency-Key');
    if (!key || !UUID_V4.test(key)) {
      throw new BadRequestException(ErrorCode.Validation);
    }
    return key;
  }

  private async claimAndRun(
    context: ExecutionContext,
    next: CallHandler,
    key: string,
    hash: string,
  ): Promise<Observable<unknown>> {
    const claimed = await this.claim(key, hash);
    if (!claimed) {
      const cached = await this.get(key);
      if (cached) return this.replay(cached, hash);
      // entry vanished between SETNX and GET — treat as a fresh miss
      return this.claimAndRun(context, next, key, hash);
    }
    return this.runHandler(context, next, key, hash);
  }

  private runHandler(
    context: ExecutionContext,
    next: CallHandler,
    key: string,
    hash: string,
  ): Observable<unknown> {
    const res = context.switchToHttp().getResponse<{ statusCode: number }>();
    return next.handle().pipe(
      concatMap((body) =>
        from(this.store(key, hash, res.statusCode, body)).pipe(
          concatMap(() => of(body)),
        ),
      ),
      catchError((err) =>
        from(this.discard(key)).pipe(concatMap(() => throwError(() => err))),
      ),
    );
  }

  private replay(cached: IdemEntry, hash: string): Observable<unknown> {
    if (cached.bodyHash !== hash) {
      throw new UnprocessableEntityException(ErrorCode.Validation);
    }
    if (cached.state === 'in_progress') {
      throw new ConflictException(ErrorCode.IdempInProgress);
    }
    return of(cached.body);
  }

  private onRedisDown(
    req: RequestWithId,
    key: string,
    err: unknown,
    next: CallHandler,
  ): Observable<unknown> {
    this.logger.warn('idem.redis_unavailable', {
      requestId: req.id,
      key,
      message: (err as Error)?.message,
    });
    if (this.config.idempotencyFailMode === 'closed') {
      throw new ServiceUnavailableException(ErrorCode.RedisClosed);
    }
    return next.handle();
  }

  private async get(key: string): Promise<IdemEntry | null> {
    const raw = await this.redis.get(this.redisKey(key));
    return raw ? (JSON.parse(raw) as IdemEntry) : null;
  }

  private async claim(key: string, hash: string): Promise<boolean> {
    const value = JSON.stringify({ state: 'in_progress', bodyHash: hash });
    const ok = await this.redis.set(
      this.redisKey(key),
      value,
      'EX',
      this.config.idempotencyInProgressTtlS,
      'NX',
    );
    return ok === 'OK';
  }

  private async store(
    key: string,
    hash: string,
    httpStatus: number,
    body: unknown,
  ): Promise<void> {
    const value = JSON.stringify({
      state: 'done',
      bodyHash: hash,
      httpStatus,
      body,
    });
    await this.redis.set(
      this.redisKey(key),
      value,
      'EX',
      this.config.idempotencyTtlS,
    );
  }

  private async discard(key: string): Promise<void> {
    try {
      await this.redis.del(this.redisKey(key));
    } catch {
      // best effort — the in_progress entry has a short TTL anyway
    }
  }

  private redisKey(key: string): string {
    return `idem:${key}`;
  }
}
