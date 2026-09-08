import { BookingOutcome } from '../enums/booking-outcome.enum';
import { ErrorCode } from '../enums/error-code.enum';

// User-facing strings for the error envelope (HLD §12 wording).
const MESSAGES: Record<string, string> = {
  [BookingOutcome.ClassFull]: 'Sorry, that seat was just taken.',
  [BookingOutcome.Duplicate]: 'You already have a booking for this class.',
  [BookingOutcome.ChildNotFound]: 'That child could not be found.',
  [BookingOutcome.PaymentFailed]: "Payment didn't go through. Try again.",
  [ErrorCode.Validation]: 'The request was not valid.',
  [ErrorCode.NotFound]: 'Not found.',
  [ErrorCode.IdempInProgress]: 'Request in progress, retry shortly.',
  [ErrorCode.RedisClosed]: 'A dependency is unavailable, retry shortly.',
  [ErrorCode.LockTimeout]: 'The system is busy, retry shortly.',
  [ErrorCode.Internal]: 'Something went wrong.',
};

export function messageFor(code: string): string {
  return MESSAGES[code] ?? 'Something went wrong.';
}
