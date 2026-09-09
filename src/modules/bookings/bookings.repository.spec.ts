import { Prisma } from '@prisma/client';
import { DuplicateBookingError } from '../../common/errors/duplicate-booking.error';
import { BookingsRepository } from './bookings.repository';

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target },
  });
}

describe('BookingsRepository.insertPending — P2002 mapping (D-Q4)', () => {
  function setup(createImpl: jest.Mock) {
    const tx = { booking: { create: createImpl } };
    const repo = new BookingsRepository({} as never);
    return { repo, tx };
  }

  it('translates a unique violation on the partial index to DuplicateBookingError', async () => {
    const { repo, tx } = setup(
      jest.fn().mockRejectedValue(p2002(['one_active_booking_per_child_class'])),
    );

    await expect(
      repo.insertPending(tx as never, 'child-1', 'class-1', 2500),
    ).rejects.toBeInstanceOf(DuplicateBookingError);
  });

  it('rethrows a unique violation on a different constraint untouched', async () => {
    const err = p2002(['some_other_key']);
    const { repo, tx } = setup(jest.fn().mockRejectedValue(err));

    await expect(
      repo.insertPending(tx as never, 'child-1', 'class-1', 2500),
    ).rejects.toBe(err);
  });

  it('returns the created id on success', async () => {
    const { repo, tx } = setup(jest.fn().mockResolvedValue({ id: 'booking-1' }));

    await expect(
      repo.insertPending(tx as never, 'child-1', 'class-1', 2500),
    ).resolves.toEqual({ id: 'booking-1' });
  });
});

describe('BookingsRepository — read/write passthroughs', () => {
  it('findOwnedChild scopes the lookup to child + parent', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'c1' });
    const repo = new BookingsRepository({ child: { findFirst } } as never);

    await expect(repo.findOwnedChild('c1', 'p1')).resolves.toEqual({ id: 'c1' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'c1', parentId: 'p1' },
    });
  });

  it('lockClassRow coerces numeric columns and returns null when the row is missing', async () => {
    const present = new BookingsRepository({} as never);
    const tx1 = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: 'cl1', capacity: 10n, price_cents: 2500n }]),
    };
    await expect(present.lockClassRow(tx1 as never, 'cl1')).resolves.toEqual({
      id: 'cl1',
      capacity: 10,
      priceCents: 2500,
    });

    const tx2 = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await expect(present.lockClassRow(tx2 as never, 'cl1')).resolves.toBeNull();
  });

  it('findActiveBooking normalises undefined to null', async () => {
    const repo = new BookingsRepository({} as never);
    const findFirst = jest.fn().mockResolvedValue(undefined);
    await expect(
      repo.findActiveBooking({ booking: { findFirst } } as never, 'c1', 'cl1'),
    ).resolves.toBeNull();

    findFirst.mockResolvedValue({ id: 'b1' });
    await expect(
      repo.findActiveBooking({ booking: { findFirst } } as never, 'c1', 'cl1'),
    ).resolves.toEqual({ id: 'b1' });
  });

  it('countConfirmed counts confirmed bookings for the class', async () => {
    const repo = new BookingsRepository({} as never);
    const count = jest.fn().mockResolvedValue(3);
    await expect(
      repo.countConfirmed({ booking: { count } } as never, 'cl1'),
    ).resolves.toBe(3);
    expect(count).toHaveBeenCalledWith({
      where: { classId: 'cl1', status: 'confirmed' },
    });
  });

  it('setStatus updates the booking row', async () => {
    const repo = new BookingsRepository({} as never);
    const update = jest.fn().mockResolvedValue(undefined);
    await repo.setStatus({ booking: { update } } as never, 'b1', 'confirmed' as never);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'confirmed' },
    });
  });

  it('recordPaymentAttempt inserts the attempt row', async () => {
    const repo = new BookingsRepository({} as never);
    const create = jest.fn().mockResolvedValue(undefined);
    const input = { bookingId: 'b1', result: 'success' as never, providerRef: 'ref' };
    await repo.recordPaymentAttempt({ paymentAttempt: { create } } as never, input);
    expect(create).toHaveBeenCalledWith({ data: input });
  });

  it('findByIdWithClass includes the trial class', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'b1', trialClass: {} });
    const repo = new BookingsRepository({ booking: { findUnique } } as never);
    await expect(repo.findByIdWithClass('b1')).resolves.toEqual({
      id: 'b1',
      trialClass: {},
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'b1' },
      include: { trialClass: true },
    });
  });
});
