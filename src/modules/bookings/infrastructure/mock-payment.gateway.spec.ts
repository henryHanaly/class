import { PaymentResult } from '../../../common/enums/payment-result.enum';
import { SimulatePayment } from '../../../common/enums/simulate-payment.enum';
import { MockPaymentGateway } from './mock-payment.gateway';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function makeGateway(delayMs: number, failRate: number): MockPaymentGateway {
  const config = {
    paymentMockDelayMs: delayMs,
    paymentMockFailRate: failRate,
  } as never;
  return new MockPaymentGateway(config, logger as never);
}

const input = (mode: SimulatePayment) => ({
  bookingId: 'b1',
  mode,
  requestId: 'r1',
});

describe('MockPaymentGateway', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns success with a non-null providerRef for mode=success', async () => {
    const res = await makeGateway(0, 0).charge(input(SimulatePayment.Success));
    expect(res.result).toBe(PaymentResult.Success);
    expect(res.providerRef).toMatch(/^mock_/);
  });

  it('returns fail with a null providerRef for mode=fail', async () => {
    const res = await makeGateway(0, 0).charge(input(SimulatePayment.Fail));
    expect(res.result).toBe(PaymentResult.Fail);
    expect(res.providerRef).toBeNull();
  });

  it('mode=random honours failRate 1 (always fail) and 0 (always success)', async () => {
    const failed = await makeGateway(0, 1).charge(input(SimulatePayment.Random));
    const ok = await makeGateway(0, 0).charge(input(SimulatePayment.Random));
    expect(failed.result).toBe(PaymentResult.Fail);
    expect(ok.result).toBe(PaymentResult.Success);
  });

  it('waits at least the configured delay', async () => {
    const start = Date.now();
    await makeGateway(50, 0).charge(input(SimulatePayment.Success));
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('logs one payment.attempt event', async () => {
    await makeGateway(0, 0).charge(input(SimulatePayment.Success));
    expect(logger.info).toHaveBeenCalledWith(
      'payment.attempt',
      expect.objectContaining({ bookingId: 'b1', result: PaymentResult.Success }),
    );
  });
});
