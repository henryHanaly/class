import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { ErrorCode } from '../enums/error-code.enum';
import { AppLogger } from '../logger/app-logger';
import { RequestWithId } from '../request-context';
import { DomainError } from './domain.error';
import { messageFor } from './error-messages';
import { isLockTimeout } from './prisma-error.util';

interface Resolved {
  status: number;
  code: string;
  level: 'warn' | 'error';
  stack?: string;
}

// Global safety net (LLD §9.2): nothing escapes unlogged. Known DomainErrors and
// framework HttpExceptions log at warn; anything unexpected logs at error + 500.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithId>();
    const res = ctx.getResponse<Response>();

    const resolved = this.resolve(exception);
    const durationMs = req.startTime ? Date.now() - req.startTime : 0;
    const route = req.route?.path ?? req.url;

    this.logger[resolved.level]('request.error', {
      requestId: req.id,
      route,
      statusCode: resolved.status,
      durationMs,
      errorName: (exception as Error)?.name,
      outcome: resolved.code,
      stack: resolved.stack,
    });

    res.status(resolved.status).json({
      error: resolved.code,
      message: messageFor(resolved.code),
      requestId: req.id,
    });
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof DomainError) {
      return { status: exception.httpStatus, code: exception.code, level: 'warn' };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, code: this.httpToCode(status), level: 'warn' };
    }
    if (isLockTimeout(exception)) {
      return { status: 503, code: ErrorCode.LockTimeout, level: 'error' };
    }
    return {
      status: 500,
      code: ErrorCode.Internal,
      level: 'error',
      stack: (exception as Error)?.stack,
    };
  }

  private httpToCode(status: number): string {
    if (status === 400 || status === 422) return ErrorCode.Validation;
    if (status === 404) return ErrorCode.NotFound;
    if (status === 409) return ErrorCode.IdempInProgress;
    if (status === 503) return ErrorCode.RedisClosed;
    return ErrorCode.Internal;
  }
}
