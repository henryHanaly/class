import { ErrorCode } from '../enums/error-code.enum';
import { DomainError } from './domain.error';

export class BookingNotFoundError extends DomainError {
  readonly httpStatus = 404;
  readonly code = ErrorCode.NotFound;
}
