import { BookingOutcome } from '../enums/booking-outcome.enum';
import { DomainError } from './domain.error';

export class ChildNotFoundError extends DomainError {
  readonly httpStatus = 404;
  readonly code = BookingOutcome.ChildNotFound;
}
