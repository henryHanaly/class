import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './common/config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(AppConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      errorHttpStatusCode: 422, // HLD §14: validation -> 422
    }),
  );
  // Production locks CORS to the configured frontend origin; outside production
  // reflect any origin so a reviewer can point any UI / port / tool at the API
  // without editing .env.
  app.enableCors(
    config.nodeEnv === 'production'
      ? { origin: config.corsOrigin }
      : { origin: true },
  );
  app.enableShutdownHooks();

  await app.listen(config.port);
}

void bootstrap();
