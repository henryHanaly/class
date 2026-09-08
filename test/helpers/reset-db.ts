import { PrismaClient } from '@prisma/client';
import { seed } from '../../prisma/seed';

// Truncate + re-seed between specs — faster than `migrate reset` per test
// (LLD §13.1).
export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "payment_attempts", "bookings", "trial_classes", "children", "parents" RESTART IDENTITY CASCADE',
  );
  await seed(prisma);
}
