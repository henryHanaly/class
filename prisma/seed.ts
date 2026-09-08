import { PrismaClient } from '@prisma/client';
import { EMAILS, IDS } from './seed-constants';

const DAY_MS = 24 * 60 * 60 * 1000;
const futureDate = (days: number): Date => new Date(Date.now() + days * DAY_MS);

// Deterministic booking ids so re-running the seed resets cleanly (LLD §12/§14).
const bookingId = (classKey: string, childKey: string): string =>
  `00000000-0000-4000-8000-0000${classKey}0000${childKey}`;

async function seedParents(prisma: PrismaClient): Promise<void> {
  await prisma.parent.upsert({
    where: { id: IDS.parentAlice },
    update: { name: 'Alice', email: EMAILS.alice },
    create: { id: IDS.parentAlice, name: 'Alice', email: EMAILS.alice },
  });
  await prisma.parent.upsert({
    where: { id: IDS.parentBob },
    update: { name: 'Bob', email: EMAILS.bob },
    create: { id: IDS.parentBob, name: 'Bob', email: EMAILS.bob },
  });
  await prisma.parent.upsert({
    where: { id: IDS.parentCarol },
    update: { name: 'Carol', email: EMAILS.carol },
    create: { id: IDS.parentCarol, name: 'Carol', email: EMAILS.carol },
  });
}

async function seedChild(
  prisma: PrismaClient,
  id: string,
  parentId: string,
  name: string,
  grade: string,
): Promise<void> {
  await prisma.child.upsert({
    where: { id },
    update: { parentId, name, grade },
    create: { id, parentId, name, grade },
  });
}

async function seedChildren(prisma: PrismaClient): Promise<void> {
  await seedChild(prisma, IDS.childAmy, IDS.parentAlice, 'Amy', 'P3');
  await seedChild(prisma, IDS.childBen, IDS.parentAlice, 'Ben', 'P4');
  await seedChild(prisma, IDS.childCleo, IDS.parentBob, 'Cleo', 'P3');
  await seedChild(prisma, IDS.childDan, IDS.parentBob, 'Dan', 'P5');
  // Carol's children — deliberately have no bookings in the seed data
  await seedChild(prisma, IDS.childEve, IDS.parentCarol, 'Eve', 'P2');
  await seedChild(prisma, IDS.childFinn, IDS.parentCarol, 'Finn', 'P3');
  await seedChild(prisma, IDS.childGwen, IDS.parentCarol, 'Gwen', 'P4');
}

async function seedClass(
  prisma: PrismaClient,
  id: string,
  subject: string,
  days: number,
  priceCents: number,
): Promise<void> {
  await prisma.trialClass.upsert({
    where: { id },
    update: { subject, startsAt: futureDate(days), capacity: 4, priceCents },
    create: { id, subject, startsAt: futureDate(days), capacity: 4, priceCents },
  });
}

async function seedClasses(prisma: PrismaClient): Promise<void> {
  await seedClass(prisma, IDS.classOpen, 'Math', 7, 2500);
  await seedClass(prisma, IDS.classLastSeat, 'Science', 8, 3000);
  await seedClass(prisma, IDS.classFull, 'Coding', 9, 2000);
  await seedClass(prisma, IDS.classEmpty, 'Art', 10, 2200); // 0 bookings — 4/4 free
}

const CLASS_PRICE_CENTS: Record<string, number> = {
  [IDS.classOpen]: 2500,
  [IDS.classLastSeat]: 3000,
  [IDS.classFull]: 2000,
  [IDS.classEmpty]: 2200,
};

async function seedConfirmedBooking(
  prisma: PrismaClient,
  classKey: string,
  childKey: string,
  childId: string,
  classId: string,
): Promise<void> {
  const id = bookingId(classKey, childKey);
  const priceCents = CLASS_PRICE_CENTS[classId] ?? 0;
  await prisma.booking.upsert({
    where: { id },
    update: { childId, classId, status: 'confirmed', priceCents },
    create: { id, childId, classId, status: 'confirmed', priceCents },
  });
  await prisma.paymentAttempt.deleteMany({ where: { bookingId: id } });
  await prisma.paymentAttempt.create({
    data: { bookingId: id, result: 'success', providerRef: `mock_seed_${id}` },
  });
}

async function seedBookings(prisma: PrismaClient): Promise<void> {
  // Class A — Amy confirmed (3 seats left; re-booking Amy = DUPLICATE_BOOKING)
  await seedConfirmedBooking(prisma, '21', '11', IDS.childAmy, IDS.classOpen);

  // Class B — Ben, Cleo, Dan confirmed (1 seat left — the race target)
  await seedConfirmedBooking(prisma, '22', '12', IDS.childBen, IDS.classLastSeat);
  await seedConfirmedBooking(prisma, '22', '13', IDS.childCleo, IDS.classLastSeat);
  await seedConfirmedBooking(prisma, '22', '14', IDS.childDan, IDS.classLastSeat);

  // Class C — all four confirmed (full — overbooking-rejection target)
  await seedConfirmedBooking(prisma, '23', '11', IDS.childAmy, IDS.classFull);
  await seedConfirmedBooking(prisma, '23', '12', IDS.childBen, IDS.classFull);
  await seedConfirmedBooking(prisma, '23', '13', IDS.childCleo, IDS.classFull);
  await seedConfirmedBooking(prisma, '23', '14', IDS.childDan, IDS.classFull);
}

export async function seed(prisma: PrismaClient): Promise<void> {
  await seedParents(prisma);
  await seedChildren(prisma);
  await seedClasses(prisma);
  await seedBookings(prisma);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seed(prisma)
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
