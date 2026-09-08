import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BookingOutcome } from '../../common/enums/booking-outcome.enum';
import { BookingStatus } from '../../common/enums/booking-status.enum';
import { PaymentResult } from '../../common/enums/payment-result.enum';
import { BookingNotFoundError } from '../../common/errors/booking-not-found.error';
import { ChildNotFoundError } from '../../common/errors/child-not-found.error';
import { ClassFullError } from '../../common/errors/class-full.error';
import { ClassNotFoundError } from '../../common/errors/class-not-found.error';
import { DuplicateBookingError } from '../../common/errors/duplicate-booking.error';
import { LockTimeoutError } from '../../common/errors/lock-timeout.error';
import { isLockTimeout } from '../../common/errors/prisma-error.util';
import { AppConfigService } from '../../common/config/app-config.service';
import { AppLogger } from '../../common/logger/app-logger';
import { RequestContext } from '../../common/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import {
  toBookingResponse,
  toBookingStatusResponse,
} from './booking.mapper';
import { BookingTxnResult } from './booking.types';
import { BookingsRepository } from './bookings.repository';
import {
  BookingResponseDto,
  BookingStatusResponseDto,
} from './dto/booking-response.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { PAYMENT_GATEWAY, PaymentGateway } from './infrastructure/payment.gateway';

type Tx = Prisma.TransactionClient;

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: BookingsRepository,
    @Inject(PAYMENT_GATEWAY) private readonly payment: PaymentGateway,
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {}

  async create(
    dto: CreateBookingDto,
    ctx: RequestContext,
  ): Promise<BookingResponseDto> {
    const child = await this.repo.findOwnedChild(dto.childId, dto.parentId);
    if (!child) throw new ChildNotFoundError();

    const result = await this.runTransaction(dto, ctx);

    this.logger.info('booking.outcome', {
      requestId: ctx.requestId,
      outcome: result.outcome,
      bookingId: result.bookingId,
      classId: dto.classId,
      childId: dto.childId,
      paymentRef: result.providerRef ?? undefined,
    });
    return toBookingResponse(result);
  }

  async getById(id: string): Promise<BookingStatusResponseDto> {
    const row = await this.repo.findByIdWithClass(id);
    if (!row) throw new BookingNotFoundError();
    return toBookingStatusResponse(row);
  }

  private async runTransaction(
    dto: CreateBookingDto,
    ctx: RequestContext,
  ): Promise<BookingTxnResult> {
    try {
      return await this.prisma.$transaction(
        (tx) => this.runBookingTxn(tx as Tx, dto, ctx),
        {
          timeout: this.config.txTimeoutMs,
          maxWait: this.config.txTimeoutMs,
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        },
      );
    } catch (err) {
      if (isLockTimeout(err)) throw new LockTimeoutError();
      throw err;
    }
  }

  // HLD §6 — one transaction, lock held across the mock payment (deliberate).
  private async runBookingTxn(
    tx: Tx,
    dto: CreateBookingDto,
    ctx: RequestContext,
  ): Promise<BookingTxnResult> {
    await tx.$executeRawUnsafe(
      `SET LOCAL lock_timeout = ${this.config.pgLockTimeoutMs}`,
    );

    const cls = await this.repo.lockClassRow(tx, dto.classId); // step 1
    if (!cls) throw new ClassNotFoundError();

    if (await this.repo.findActiveBooking(tx, dto.childId, dto.classId)) {
      throw new DuplicateBookingError(); // step 2 fast path
    }

    const confirmed = await this.repo.countConfirmed(tx, dto.classId); // step 3
    if (confirmed >= cls.capacity) throw new ClassFullError();

    const booking = await this.repo.insertPending(
      tx,
      dto.childId,
      dto.classId,
      cls.priceCents,
    ); // step 4
    return this.chargeAndResolve(tx, booking.id, cls.priceCents, dto, ctx); // steps 5-6
  }

  private async chargeAndResolve(
    tx: Tx,
    bookingId: string,
    priceCents: number,
    dto: CreateBookingDto,
    ctx: RequestContext,
  ): Promise<BookingTxnResult> {
    const charge = await this.payment.charge({
      bookingId,
      mode: dto.simulatePayment,
      requestId: ctx.requestId,
    });
    await this.repo.recordPaymentAttempt(tx, {
      bookingId,
      result: charge.result,
      providerRef: charge.providerRef,
    });

    const success = charge.result === PaymentResult.Success;
    const status = success
      ? BookingStatus.Confirmed
      : BookingStatus.PaymentFailed;
    await this.repo.setStatus(tx, bookingId, status);

    return {
      bookingId,
      status,
      outcome: success
        ? BookingOutcome.Confirmed
        : BookingOutcome.PaymentFailed,
      providerRef: charge.providerRef,
      paymentResult: charge.result,
      priceCents,
    };
  }
}
