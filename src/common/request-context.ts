import { Request } from 'express';

// Set by RequestLoggingInterceptor, read by the service and the filter.
export interface RequestWithId extends Request {
  id: string;
  startTime: number;
}

export interface RequestContext {
  requestId: string;
}
