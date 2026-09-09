import { configSchema } from './config.schema';

const REQUIRED = {
  DATABASE_URL: 'postgres://localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('configSchema', () => {
  it('applies defaults when only the required vars are present', () => {
    const { error, value } = configSchema.validate(REQUIRED);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      CORS_ORIGIN: 'http://localhost:5173',
      PAYMENT_MOCK_MODE: true,
      IDEMPOTENCY_FAIL_MODE: 'open',
    });
  });

  it('reports every problem at once (abortEarly: false)', () => {
    const { error } = configSchema.validate({});
    expect(error).toBeDefined();
    expect(error!.details.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a non-mock payment mode in production', () => {
    const { error } = configSchema.validate({
      ...REQUIRED,
      NODE_ENV: 'production',
      PAYMENT_MOCK_MODE: false,
    });
    expect(error).toBeDefined();
  });

  it('allows mock payment mode in production', () => {
    const { error } = configSchema.validate({
      ...REQUIRED,
      NODE_ENV: 'production',
      PAYMENT_MOCK_MODE: true,
    });
    expect(error).toBeUndefined();
  });
});
