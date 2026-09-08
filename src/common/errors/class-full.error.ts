import { BookingOutcome } from '../enums/booking-outcome.enum';
import { DomainError } from './domain.error';

export class ClassFullError extends DomainError {
  readonly httpStatus = 409;
  readonly code = BookingOutcome.ClassFull;
}
