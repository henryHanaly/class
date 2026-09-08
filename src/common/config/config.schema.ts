import * as Joi from 'joi';

// Validated on boot (HLD §14). `abortEarly: false` so every problem is reported.
export const configSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  DATABASE_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  PORT: Joi.number().port().default(3000),
  CORS_ORIGIN: Joi.string().uri().default('http://localhost:5173'),
  PAYMENT_MOCK_MODE: Joi.boolean().default(true),
  PAYMENT_MOCK_DELAY_MS: Joi.number().min(0).max(5000).default(150),
  PAYMENT_MOCK_FAIL_RATE: Joi.number().min(0).max(1).default(0),
  PG_LOCK_TIMEOUT_MS: Joi.number().min(0).default(3000),
  PG_POOL_SIZE: Joi.number().min(1).default(20),
  TX_TIMEOUT_MS: Joi.number().min(1000).default(15000),
  IDEMPOTENCY_TTL_S: Joi.number().default(86400),
  IDEMPOTENCY_INPROGRESS_TTL_S: Joi.number().default(60),
  IDEMPOTENCY_FAIL_MODE: Joi.string().valid('open', 'closed').default('open'),
})
  .custom((value, helpers) => {
    // HLD §14 — must be mock outside prod.
    if (value.NODE_ENV === 'production' && value.PAYMENT_MOCK_MODE !== true) {
      return helpers.error('any.invalid');
    }
    return value;
  })
  // report every problem, not just the first (LLD §3)
  .options({ abortEarly: false });
