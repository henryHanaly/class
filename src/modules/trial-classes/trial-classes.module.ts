import { Module } from '@nestjs/common';
import { TrialClassesController } from './trial-classes.controller';
import { TrialClassesRepository } from './trial-classes.repository';
import { TrialClassesService } from './trial-classes.service';

@Module({
  controllers: [TrialClassesController],
  providers: [TrialClassesService, TrialClassesRepository],
})
export class TrialClassesModule {}
