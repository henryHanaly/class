import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { BookingsRepository } from './bookings.repository';
import { BookingsService } from './bookings.service';
import { MockPaymentGateway } from './infrastructure/mock-payment.gateway';
import { PAYMENT_GATEWAY } from './infrastructure/payment.gateway';

@Module({
  controllers: [BookingsController],
  providers: [
    BookingsService,
    BookingsRepository,
    { provide: PAYMENT_GATEWAY, useClass: MockPaymentGateway },
  ],
})
export class BookingsModule {}
