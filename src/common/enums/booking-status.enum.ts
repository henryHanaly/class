// Mirrors the Prisma `BookingStatus` enum. Used where we don't want the
// generated Prisma enum leaking into the DTO / policy layers.
export enum BookingStatus {
  PendingPayment = 'pending_payment',
  Confirmed = 'confirmed',
  PaymentFailed = 'payment_failed',
  Cancelled = 'cancelled',
}
