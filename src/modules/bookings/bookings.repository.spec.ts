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
