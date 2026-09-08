import { Prisma } from '@prisma/client';

// P2002 = unique constraint violation. We only treat it as a duplicate booking
// when it fires on the partial unique index (LLD §5.3 / §6.4).
export function isUniqueViolationOn(error: unknown, indexName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  const target = error.meta?.target;
  if (typeof target === 'string') return target.includes(indexName);
  if (Array.isArray(target)) return target.some((t) => String(t).includes(indexName));
  return false;
}

// Postgres `lock_timeout` (SQLSTATE 57014) surfaces through Prisma as P2028
// (transaction API error) or P2010 (raw query failed) (LLD §6.4).
export function isLockTimeout(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2028' || error.code === 'P2010') {
      return JSON.stringify(error.meta ?? {}).includes('57014') || /lock_timeout|canceling statement/i.test(error.message);
    }
  }
  return /57014|lock timeout|canceling statement due to lock timeout/i.test(
    String((error as { message?: string })?.message ?? ''),
  );
}
