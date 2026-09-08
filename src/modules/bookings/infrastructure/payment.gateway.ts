import { SimulatePayment } from '../../../common/enums/simulate-payment.enum';
import { PaymentChargeResult } from '../booking.types';

export interface ChargeInput {
  bookingId: string;
  mode: SimulatePayment;
  requestId: string;
}

export abstract class PaymentGateway {
  abstract charge(input: ChargeInput): Promise<PaymentChargeResult>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
