import { Injectable } from '@nestjs/common';
import { AppLogger } from './app-logger';

// Structured JSON to stdout, one line per event (LLD §10).
@Injectable()
export class ConsoleLogger extends AppLogger {
  info(event: string, context: Record<string, unknown>): void {
    this.write('info', event, context);
  }

  warn(event: string, context: Record<string, unknown>): void {
    this.write('warn', event, context);
  }

  error(event: string, context: Record<string, unknown>): void {
    this.write('error', event, context);
  }

  debug(event: string, context: Record<string, unknown>): void {
    this.write('debug', event, context);
  }

  private write(
    level: string,
    event: string,
    context: Record<string, unknown>,
  ): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...context,
    });
    process.stdout.write(line + '\n');
  }
}
