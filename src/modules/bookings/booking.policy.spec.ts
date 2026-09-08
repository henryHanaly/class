import { BookingStatus } from '../../common/enums/booking-status.enum';
import { canRetry } from './booking.policy';

describe('booking.policy — canRetry', () => {
  it('allows retry only after a failed payment', () => {
    expect(canRetry(BookingStatus.PaymentFailed)).toBe(true);
  });

  it('rejects retry for a confirmed booking', () => {
    expect(canRetry(BookingStatus.Confirmed)).toBe(false);
  });

  it('rejects retry while pending', () => {
    expect(canRetry(BookingStatus.PendingPayment)).toBe(false);
  });
});
