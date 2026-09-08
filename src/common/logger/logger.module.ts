import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger';
import { ConsoleLogger } from './console-logger';

@Global()
@Module({
  providers: [{ provide: AppLogger, useClass: ConsoleLogger }],
  exports: [AppLogger],
})
export class LoggerModule {}
