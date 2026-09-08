import { BookingOutcome } from '../enums/booking-outcome.enum';
import { ErrorCode } from '../enums/error-code.enum';

// Base for every expected (non-bug) failure. Each subclass carries the HTTP
// status and the envelope code; the global filter maps and logs it (HLD §13).
export abstract class DomainError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: BookingOutcome | ErrorCode;

  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}
