import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    PORT: 3000,
    CORS_ORIGIN: 'http://localhost:5173',
    PAYMENT_MOCK_DELAY_MS: 150,
    PAYMENT_MOCK_FAIL_RATE: 0,
    PG_LOCK_TIMEOUT_MS: 3000,
    TX_TIMEOUT_MS: 15000,
    IDEMPOTENCY_TTL_S: 86400,
    IDEMPOTENCY_INPROGRESS_TTL_S: 60,
    IDEMPOTENCY_FAIL_MODE: 'open',
    REDIS_URL: 'redis://localhost:6379',
  };
  const config = new AppConfigService({
    get: (key: string) => values[key],
  } as never);

  it('exposes every typed accessor over the underlying ConfigService', () => {
    expect(config.nodeEnv).toBe('test');
    expect(config.port).toBe(3000);
    expect(config.corsOrigin).toBe('http://localhost:5173');
    expect(config.paymentMockDelayMs).toBe(150);
    expect(config.paymentMockFailRate).toBe(0);
    expect(config.pgLockTimeoutMs).toBe(3000);
    expect(config.txTimeoutMs).toBe(15000);
    expect(config.idempotencyTtlS).toBe(86400);
    expect(config.idempotencyInProgressTtlS).toBe(60);
    expect(config.idempotencyFailMode).toBe('open');
    expect(config.redisUrl).toBe('redis://localhost:6379');
  });
});
