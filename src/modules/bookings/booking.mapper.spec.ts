import { BookingOutcome } from '../../common/enums/booking-outcome.enum';
import { BookingStatus } from '../../common/enums/booking-status.enum';
import { PaymentResult } from '../../common/enums/payment-result.enum';
import { toBookingResponse, toBookingStatusResponse } from './booking.mapper';

describe('booking.mapper', () => {
  it('maps a confirmed txn result to the response shape', () => {
    expect(
      toBookingResponse({
        bookingId: 'b1',
        status: BookingStatus.Confirmed,
        outcome: BookingOutcome.Confirmed,
        providerRef: 'mock_ref',
        paymentResult: PaymentResult.Success,
        priceCents: 2500,
      }),
    ).toEqual({
      bookingId: 'b1',
      status: 'confirmed',
      priceCents: 2500,
      payment: { result: 'success' },
    });
  });

  it('maps a payment_failed txn result', () => {
    expect(
      toBookingResponse({
        bookingId: 'b1',
        status: BookingStatus.PaymentFailed,
        outcome: BookingOutcome.PaymentFailed,
        providerRef: null,
        paymentResult: PaymentResult.Fail,
        priceCents: 2500,
      }),
    ).toEqual({
      bookingId: 'b1',
      status: 'payment_failed',
      priceCents: 2500,
      payment: { result: 'fail' },
    });
  });

  it('status DTO omits internal columns like updatedAt', () => {
    const createdAt = new Date('2026-02-03T04:05:06.000Z');
    const dto = toBookingStatusResponse({
      id: 'b1',
      childId: 'c1',
      classId: 'cl1',
      status: 'confirmed',
      priceCents: 2500,
      createdAt,
      updatedAt: new Date(),
    } as never);

    expect(dto).toEqual({
      bookingId: 'b1',
      status: 'confirmed',
      classId: 'cl1',
      childId: 'c1',
      priceCents: 2500,
      createdAt: createdAt.toISOString(),
    });
    expect(dto).not.toHaveProperty('updatedAt');
  });
});
