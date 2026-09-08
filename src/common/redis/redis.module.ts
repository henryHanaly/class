import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { AppLogger } from '../logger/app-logger';
import { REDIS_CLIENT } from './redis.constants';

// Fail-fast client (LLD §4.3): a dead Redis errors quickly instead of hanging
// the request, so the idempotency interceptor can fall back per config.
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService, AppLogger],
      useFactory: (config: AppConfigService, logger: AppLogger): Redis => {
        const client = new Redis(config.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          commandTimeout: 500,
        });
        client.on('error', (err) =>
          logger.warn('redis.error', { message: err.message }),
        );
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
