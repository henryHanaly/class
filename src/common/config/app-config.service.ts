import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Typed accessor over ConfigService so no `configService.get<T>('KEY')!` string
// keys leak into the rest of the app (LLD §3).
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  private num(key: string): number {
    return this.config.get<number>(key) as number;
  }

  private str(key: string): string {
    return this.config.get<string>(key) as string;
  }

  get nodeEnv(): string {
    return this.str('NODE_ENV');
  }

  get port(): number {
    return this.num('PORT');
  }

  get corsOrigin(): string {
    return this.str('CORS_ORIGIN');
  }

  get paymentMockDelayMs(): number {
    return this.num('PAYMENT_MOCK_DELAY_MS');
  }

  get paymentMockFailRate(): number {
    return this.num('PAYMENT_MOCK_FAIL_RATE');
  }

  get pgLockTimeoutMs(): number {
    return this.num('PG_LOCK_TIMEOUT_MS');
  }

  get txTimeoutMs(): number {
    return this.num('TX_TIMEOUT_MS');
  }

  get idempotencyTtlS(): number {
    return this.num('IDEMPOTENCY_TTL_S');
  }

  get idempotencyInProgressTtlS(): number {
    return this.num('IDEMPOTENCY_INPROGRESS_TTL_S');
  }

  get idempotencyFailMode(): 'open' | 'closed' {
    return this.str('IDEMPOTENCY_FAIL_MODE') as 'open' | 'closed';
  }

  get redisUrl(): string {
    return this.str('REDIS_URL');
  }
}
