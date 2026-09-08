import { BookingStatus } from '../../common/enums/booking-status.enum';
import { PaymentResult } from '../../common/enums/payment-result.enum';
import { SimulatePayment } from '../../common/enums/simulate-payment.enum';
import { BookingNotFoundError } from '../../common/errors/booking-not-found.error';
import { ChildNotFoundError } from '../../common/errors/child-not-found.error';
import { ClassFullError } from '../../common/errors/class-full.error';
import { ClassNotFoundError } from '../../common/errors/class-not-found.error';
import { DuplicateBookingError } from '../../common/errors/duplicate-booking.error';
import { LockTimeoutError } from '../../common/errors/lock-timeout.error';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';

const CTX = { requestId: 'req-1' };

function buildDto(): CreateBookingDto {
  return {
    parentId: 'parent-1',
    childId: 'child-1',
    classId: 'class-1',
    simulatePayment: SimulatePayment.Success,
  };
}

function setup() {
  const repo = {
    findOwnedChild: jest.fn().mockResolvedValue({ id: 'child-1' }),
    lockClassRow: jest
      .fn()
      .mockResolvedValue({ id: 'class-1', capacity: 4, priceCents: 2500 }),
    findActiveBooking: jest.fn().mockResolvedValue(null),
    countConfirmed: jest.fn().mockResolvedValue(1),
    insertPending: jest.fn().mockResolvedValue({ id: 'booking-1' }),
    recordPaymentAttempt: jest.fn().mockResolvedValue(undefined),
    setStatus: jest.fn().mockResolvedValue(undefined),
    findByIdWithClass: jest.fn(),
  };
  const payment = {
    charge: jest.fn().mockResolvedValue({
      result: PaymentResult.Success,
      providerRef: 'mock_ref',
      durationMs: 1,
    }),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const config = { txTimeoutMs: 15000, pgLockTimeoutMs: 3000 } as never;
  const tx = { $executeRawUnsafe: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };

  const service = new BookingsService(
    prisma as never,
    repo as never,
    payment as never,
    config,
    logger as never,
  );
  return { service, repo, payment, logger, prisma };
}

describe('BookingsService.create', () => {
  it('throws ChildNotFoundError and never opens a transaction', async () => {
    const { service, repo, prisma } = setup();
    repo.findOwnedChild.mockResolvedValue(null);

    await expect(service.create(buildDto(), CTX)).rejects.toBeInstanceOf(
      ChildNotFoundError,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws ClassNotFoundError when the class row is missing', async () => {
    const { service, repo, payment } = setup();
    repo.lockClassRow.mockResolvedValue(null);

    await expect(service.create(buildDto(), CTX)).rejects.toBeInstanceOf(
      ClassNotFoundError,
    );
    expect(payment.charge).not.toHaveBeenCalled();
  });

  it('throws DuplicateBookingError on the fast-path check', async () => {
    const { service, repo, payment } = setup();
    repo.findActiveBooking.mockResolvedValue({ id: 'existing' });

    await expect(service.create(buildDto(), CTX)).rejects.toBeInstanceOf(
      DuplicateBookingError,
    );
    expect(payment.charge).not.toHaveBeenCalled();
  });

  it('throws ClassFullError without calling the gateway when at capacity', async () => {
    const { service, repo, payment } = setup();
    repo.countConfirmed.mockResolvedValue(4);

    await expect(service.create(buildDto(), CTX)).rejects.toBeInstanceOf(
      ClassFullError,
    );
    expect(payment.charge).not.toHaveBeenCalled();
  });

  it('propagates DuplicateBookingError from insertPending (P2002 race)', async () => {
    const { service, repo } = setup();
    repo.insertPending.mockRejectedValue(new DuplicateBookingError());

    await expect(service.create(buildDto(), CTX)).rejects.toBeInstanceOf(
      DuplicateBookingError,
    );
  });

  it('maps a Postgres lock_timeout to LockTimeoutError → 503 (D-Q1)', async () => {
    const { service, prisma } = setup();
    (prisma.$transaction as jest.Mock).mockRejectedValue(
      new Error('canceling statement due to lock timeout'),
    );

    await expect(service.create(buildDto(), CTX)).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
  });

  it('on payment failure: records the attempt, sets payment_failed, still commits', async () => {
    const { service, repo, payment } = setup();
    payment.charge.mockResolvedValue({
      result: PaymentResult.Fail,
      providerRef: null,
      durationMs: 1,
    });

    const res = await service.create(buildDto(), CTX);

    expect(res).toEqual({
      bookingId: 'booking-1',
      status: 'payment_failed',
      priceCents: 2500,
      payment: { result: 'fail' },
    });
    expect(repo.recordPaymentAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: PaymentResult.Fail }),
    );
    expect(repo.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'booking-1',
      BookingStatus.PaymentFailed,
    );
  });

  it('snapshots the class price onto the booking row and the response', async () => {
    const { service, repo } = setup();
    repo.lockClassRow.mockResolvedValue({
      id: 'class-1',
      capacity: 4,
      priceCents: 3000,
    });

    const res = await service.create(buildDto(), CTX);

    expect(repo.insertPending).toHaveBeenCalledWith(
      expect.anything(),
      'child-1',
      'class-1',
      3000,
    );
    expect(res.priceCents).toBe(3000);
  });

  it('on payment success: confirms the booking and returns the mapped shape', async () => {
    const { service, repo } = setup();

    const res = await service.create(buildDto(), CTX);

    expect(res).toEqual({
      bookingId: 'booking-1',
      status: 'confirmed',
      priceCents: 2500,
      payment: { result: 'success' },
    });
    expect(repo.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'booking-1',
      BookingStatus.Confirmed,
    );
  });
});

describe('BookingsService.getById', () => {
  it('throws BookingNotFoundError for an unknown id', async () => {
    const { service, repo } = setup();
    repo.findByIdWithClass.mockResolvedValue(null);

    await expect(service.getById('missing')).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
  });

  it('maps the row to the status DTO', async () => {
    const { service, repo } = setup();
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    repo.findByIdWithClass.mockResolvedValue({
      id: 'booking-1',
      childId: 'child-1',
      classId: 'class-1',
      status: 'confirmed',
      priceCents: 2500,
      createdAt,
      updatedAt: createdAt,
      trialClass: { subject: 'Math' },
    });

    await expect(service.getById('booking-1')).resolves.toEqual({
      bookingId: 'booking-1',
      status: 'confirmed',
      classId: 'class-1',
      childId: 'child-1',
      priceCents: 2500,
      createdAt: createdAt.toISOString(),
    });
  });
});
