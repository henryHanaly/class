// The string that flows into logs, the error envelope, and the frontend
// switch (HLD §13).
export enum BookingOutcome {
  Confirmed = 'BOOKING_CONFIRMED',
  PaymentFailed = 'BOOKING_PAYMENT_FAILED',
  ClassFull = 'BOOKING_CLASS_FULL',
  Duplicate = 'BOOKING_DUPLICATE',
  ChildNotFound = 'BOOKING_CHILD_NOT_FOUND',
}
