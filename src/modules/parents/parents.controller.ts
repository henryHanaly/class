import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { LookupParentDto } from './dto/lookup-parent.dto';
import { ParentLookupResponseDto } from './dto/parent-response.dto';
import { ParentsService } from './parents.service';

@Controller('parents')
export class ParentsController {
  constructor(private readonly service: ParentsService) {}

  @Post('lookup')
  @HttpCode(200)
  lookup(@Body() dto: LookupParentDto): Promise<ParentLookupResponseDto> {
    return this.service.lookup(dto);
  }
}
