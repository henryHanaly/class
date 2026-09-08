import { BookingStatus } from '../../../common/enums/booking-status.enum';

export class BookingResponseDto {
  bookingId!: string;
  status!: 'confirmed' | 'payment_failed';
  priceCents!: number;
  payment!: { result: 'success' | 'fail' };
}

export class BookingStatusResponseDto {
  bookingId!: string;
  status!: BookingStatus;
  classId!: string;
  childId!: string;
  priceCents!: number;
  createdAt!: string;
}
