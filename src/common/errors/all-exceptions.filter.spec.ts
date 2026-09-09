import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../enums/error-code.enum';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ClassFullError } from './class-full.error';

function setup() {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const filter = new AllExceptionsFilter(logger as never);
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { filter, logger, json, status };
}

function host(req: unknown, res: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
}

const baseReq = {
  id: 'req-1',
  url: '/bookings',
  route: { path: '/bookings' },
  startTime: Date.now() - 5,
};

describe('AllExceptionsFilter', () => {
  it('maps a DomainError to its http status + envelope code and warn-logs it', () => {
    const { filter, logger, json, status } = setup();
    filter.catch(new ClassFullError(), host(baseReq, { status }));
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'BOOKING_CLASS_FULL', requestId: 'req-1' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'request.error',
      expect.objectContaining({ statusCode: 409 }),
    );
  });

  it.each([
    [new BadRequestException(), 400, ErrorCode.Validation],
    [new UnprocessableEntityException(), 422, ErrorCode.Validation],
    [new NotFoundException(), 404, ErrorCode.NotFound],
    [new HttpException('conflict', 409), 409, ErrorCode.IdempInProgress],
    [new ServiceUnavailableException(), 503, ErrorCode.RedisClosed],
    [new ForbiddenException(), 403, ErrorCode.Internal],
  ])('maps HttpException #%#', (exc, expectedStatus, expectedCode) => {
    const { filter, json, status } = setup();
    filter.catch(exc, host(baseReq, { status }));
    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expectedCode }),
    );
  });

  it('maps a Postgres lock timeout to 503 and error-logs it', () => {
    const { filter, logger, status } = setup();
    const err = new Prisma.PrismaClientKnownRequestError('lock', {
      code: 'P2028',
      clientVersion: '5.22.0',
      meta: { code: '57014' },
    });
    filter.catch(err, host(baseReq, { status }));
    expect(status).toHaveBeenCalledWith(503);
    expect(logger.error).toHaveBeenCalledWith(
      'request.error',
      expect.objectContaining({ statusCode: 503, outcome: ErrorCode.LockTimeout }),
    );
  });

  it('maps an unknown error to 500 and includes the stack in the error log', () => {
    const { filter, logger, status, json } = setup();
    filter.catch(new Error('boom'), host(baseReq, { status }));
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: ErrorCode.Internal }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'request.error',
      expect.objectContaining({ stack: expect.any(String) }),
    );
  });

  it('tolerates a request with no startTime and no matched route', () => {
    const { filter, logger, status } = setup();
    filter.catch(new Error('boom'), host({ id: 'r2', url: '/x' }, { status }));
    expect(logger.error).toHaveBeenCalledWith(
      'request.error',
      expect.objectContaining({ route: '/x', durationMs: 0 }),
    );
  });
});
