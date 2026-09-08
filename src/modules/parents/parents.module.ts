import { Module } from '@nestjs/common';
import { ParentsController } from './parents.controller';
import { ParentsRepository } from './parents.repository';
import { ParentsService } from './parents.service';

@Module({
  controllers: [ParentsController],
  providers: [ParentsService, ParentsRepository],
})
export class ParentsModule {}
