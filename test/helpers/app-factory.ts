import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

export interface E2eContext {
  app: INestApplication;
  prisma: PrismaClient;
  close: () => Promise<void>;
}

// In-process Nest app wired exactly like main.ts (LLD §13.1 / §11.1).
export async function createE2eApp(): Promise<E2eContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      errorHttpStatusCode: 422,
    }),
  );
  await app.init();

  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    close: async () => {
      await app.close();
    },
  };
}
