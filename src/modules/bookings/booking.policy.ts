import { BookingStatus } from '../../common/enums/booking-status.enum';

// Pure rule (HLD §9): a booking can be retried only after a failed payment.
export function canRetry(status: BookingStatus | string): boolean {
  return status === BookingStatus.PaymentFailed;
}
