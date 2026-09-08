import { Injectable } from '@nestjs/common';
import { Booking, Child, Prisma, TrialClass } from '@prisma/client';
import { BookingStatus } from '../../common/enums/booking-status.enum';
import { PaymentResult } from '../../common/enums/payment-result.enum';
import { DuplicateBookingError } from '../../common/errors/duplicate-booking.error';
import { isUniqueViolationOn } from '../../common/errors/prisma-error.util';
import { PrismaService } from '../../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

const ACTIVE_STATUSES = [
  BookingStatus.PendingPayment,
  BookingStatus.Confirmed,
] as const;

const DUPLICATE_INDEX = 'one_active_booking_per_child_class';

// The only place Prisma is touched for this module (HLD §13). Write methods take
// the transaction client so the whole §6 use case is one transaction.
@Injectable()
export class BookingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // child + ownership check (HLD §5). null if child missing OR not owned.
  findOwnedChild(childId: string, parentId: string): Promise<Child | null> {
    return this.prisma.child.findFirst({ where: { id: childId, parentId } });
  }

  async lockClassRow(
    tx: Tx,
    classId: string,
  ): Promise<{ id: string; capacity: number; priceCents: number } | null> {
    const rows = await tx.$queryRaw<
      { id: string; capacity: number; price_cents: number }[]
    >`
      SELECT id, capacity, price_cents FROM trial_classes WHERE id = ${classId}::uuid FOR UPDATE`;
    const row = rows[0];
    return row
      ? { id: row.id, capacity: Number(row.capacity), priceCents: Number(row.price_cents) }
      : null;
  }

  async findActiveBooking(
    tx: Tx,
    childId: string,
    classId: string,
  ): Promise<{ id: string } | null> {
    const row = await tx.booking.findFirst({
      where: { childId, classId, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true },
    });
    return row ?? null;
  }

  async countConfirmed(tx: Tx, classId: string): Promise<number> {
    return tx.booking.count({
      where: { classId, status: BookingStatus.Confirmed },
    });
  }

  async insertPending(
    tx: Tx,
    childId: string,
    classId: string,
    priceCents: number,
  ): Promise<{ id: string }> {
    try {
      const row = await tx.booking.create({
        data: {
          childId,
          classId,
          priceCents,
          status: BookingStatus.PendingPayment,
        },
        select: { id: true },
      });
      return row;
    } catch (err) {
      if (isUniqueViolationOn(err, DUPLICATE_INDEX)) {
        throw new DuplicateBookingError();
      }
      throw err;
    }
  }

  async setStatus(
    tx: Tx,
    bookingId: string,
    status: BookingStatus,
  ): Promise<void> {
    await tx.booking.update({ where: { id: bookingId }, data: { status } });
  }

  async recordPaymentAttempt(
    tx: Tx,
    input: { bookingId: string; result: PaymentResult; providerRef: string | null },
  ): Promise<void> {
    await tx.paymentAttempt.create({ data: input });
  }

  findByIdWithClass(
    id: string,
  ): Promise<(Booking & { trialClass: TrialClass }) | null> {
    return this.prisma.booking.findUnique({
      where: { id },
      include: { trialClass: true },
    });
  }
}
