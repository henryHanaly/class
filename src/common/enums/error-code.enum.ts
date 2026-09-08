// Non-booking envelope codes (HLD §14 error envelope).
export enum ErrorCode {
  Validation = 'VALIDATION_ERROR',
  NotFound = 'NOT_FOUND',
  IdempInProgress = 'IDEMPOTENCY_IN_PROGRESS',
  RedisClosed = 'DEPENDENCY_UNAVAILABLE',
  LockTimeout = 'LOCK_TIMEOUT',
  Internal = 'INTERNAL_ERROR',
}
