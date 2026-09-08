import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ClassResponseDto } from './dto/class-response.dto';
import { RosterResponseDto } from './dto/roster-response.dto';
import { TrialClassesService } from './trial-classes.service';

@Controller('trial-classes')
export class TrialClassesController {
  constructor(private readonly service: TrialClassesService) {}

  @Get()
  list(): Promise<ClassResponseDto[]> {
    return this.service.listUpcoming();
  }

  @Get(':id/roster')
  roster(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RosterResponseDto> {
    return this.service.getRoster(id);
  }
}
