import { ErrorCode } from '../enums/error-code.enum';
import { DomainError } from './domain.error';

export class LockTimeoutError extends DomainError {
  readonly httpStatus = 503;
  readonly code = ErrorCode.LockTimeout;
}
