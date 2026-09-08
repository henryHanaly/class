import { BookingOutcome } from '../../common/enums/booking-outcome.enum';
import { BookingStatus } from '../../common/enums/booking-status.enum';
import { PaymentResult } from '../../common/enums/payment-result.enum';

export interface PaymentChargeResult {
  result: PaymentResult;
  providerRef: string | null; // set on success, null on fail
  durationMs: number;
}

// What runBookingTxn returns to the service (LLD §6.2).
export interface BookingTxnResult {
  bookingId: string;
  status: BookingStatus.Confirmed | BookingStatus.PaymentFailed;
  outcome: BookingOutcome.Confirmed | BookingOutcome.PaymentFailed;
  providerRef: string | null;
  paymentResult: PaymentResult;
  priceCents: number;
}
