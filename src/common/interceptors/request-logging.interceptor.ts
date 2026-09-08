import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, tap } from 'rxjs';
import { AppLogger } from '../logger/app-logger';
import { RequestWithId } from '../request-context';

// Global (LLD §9.3): stamps every request with an id + start time, and logs one
// `http.response` line per successful request. Errors are logged by the filter.
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: AppLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithId>();
    req.id = randomUUID();
    req.startTime = Date.now();

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse<{ statusCode: number }>();
        this.logger.info('http.response', {
          requestId: req.id,
          method: req.method,
          route: req.route?.path ?? req.url,
          statusCode: res.statusCode,
          durationMs: Date.now() - req.startTime,
        });
      }),
    );
  }
}
