import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import type { RequestWithId } from '../../common/request-context';
import { BookingsService } from './bookings.service';
import {
  BookingResponseDto,
  BookingStatusResponseDto,
} from './dto/booking-response.dto';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly service: BookingsService) {}

  @Post()
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() dto: CreateBookingDto,
    @Req() req: RequestWithId,
  ): Promise<BookingResponseDto> {
    return this.service.create(dto, { requestId: req.id });
  }

  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingStatusResponseDto> {
    return this.service.getById(id);
  }
}
