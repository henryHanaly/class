import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../../common/config/app-config.service';
import { PaymentResult } from '../../../common/enums/payment-result.enum';
import { SimulatePayment } from '../../../common/enums/simulate-payment.enum';
import { AppLogger } from '../../../common/logger/app-logger';
import { sleep } from '../../../common/utils/time';
import { PaymentChargeResult } from '../booking.types';
import { ChargeInput, PaymentGateway } from './payment.gateway';

// Synchronous mock (HLD §6). The artificial delay widens the last-seat race
// window so the concurrency test is meaningful.
@Injectable()
export class MockPaymentGateway extends PaymentGateway {
  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  async charge({
    bookingId,
    mode,
    requestId,
  }: ChargeInput): Promise<PaymentChargeResult> {
    const start = Date.now();
    await sleep(this.config.paymentMockDelayMs);

    const ok = this.decide(mode);
    const durationMs = Date.now() - start;
    const result = ok ? PaymentResult.Success : PaymentResult.Fail;
    const providerRef = ok ? `mock_${randomUUID()}` : null;

    this.logger.info('payment.attempt', {
      requestId,
      bookingId,
      result,
      ref: providerRef,
      durationMs,
    });
    return { result, providerRef, durationMs };
  }

  private decide(mode: SimulatePayment): boolean {
    if (mode === SimulatePayment.Success) return true;
    if (mode === SimulatePayment.Fail) return false;
    return Math.random() >= this.config.paymentMockFailRate;
  }
}
