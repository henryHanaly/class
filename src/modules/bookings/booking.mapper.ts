import { Booking } from '@prisma/client';
import { BookingStatus } from '../../common/enums/booking-status.enum';
import { PaymentResult } from '../../common/enums/payment-result.enum';
import { BookingTxnResult } from './booking.types';
import {
  BookingResponseDto,
  BookingStatusResponseDto,
} from './dto/booking-response.dto';

// Prisma row / txn result -> response DTO. Internal columns never leak (HLD §13).
export function toBookingResponse(result: BookingTxnResult): BookingResponseDto {
  return {
    bookingId: result.bookingId,
    status:
      result.status === BookingStatus.Confirmed ? 'confirmed' : 'payment_failed',
    priceCents: result.priceCents,
    payment: {
      result:
        result.paymentResult === PaymentResult.Success ? 'success' : 'fail',
    },
  };
}

export function toBookingStatusResponse(
  row: Booking,
): BookingStatusResponseDto {
  return {
    bookingId: row.id,
    status: row.status as BookingStatus,
    classId: row.classId,
    childId: row.childId,
    priceCents: row.priceCents,
    createdAt: row.createdAt.toISOString(),
  };
}
