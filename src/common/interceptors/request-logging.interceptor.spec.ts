import { firstValueFrom, of } from 'rxjs';
import { RequestLoggingInterceptor } from './request-logging.interceptor';

function setup() {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { interceptor: new RequestLoggingInterceptor(logger as never), logger };
}

function ctx(req: Record<string, unknown>, statusCode = 200) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  } as never;
}

describe('RequestLoggingInterceptor', () => {
  it('stamps the request with an id + start time and logs http.response on success', async () => {
    const { interceptor, logger } = setup();
    const req: Record<string, unknown> = { method: 'GET', route: { path: '/health' } };

    const result = await firstValueFrom(
      interceptor.intercept(ctx(req, 201), { handle: () => of({ ok: true }) } as never),
    );

    expect(result).toEqual({ ok: true });
    expect(typeof req.id).toBe('string');
    expect(typeof req.startTime).toBe('number');
    expect(logger.info).toHaveBeenCalledWith(
      'http.response',
      expect.objectContaining({
        method: 'GET',
        route: '/health',
        statusCode: 201,
        durationMs: expect.any(Number),
      }),
    );
  });

  it('falls back to req.url when there is no matched route', async () => {
    const { interceptor, logger } = setup();
    const req: Record<string, unknown> = { method: 'POST', url: '/bookings' };

    await firstValueFrom(
      interceptor.intercept(ctx(req), { handle: () => of(null) } as never),
    );

    expect(logger.info).toHaveBeenCalledWith(
      'http.response',
      expect.objectContaining({ route: '/bookings' }),
    );
  });
});
