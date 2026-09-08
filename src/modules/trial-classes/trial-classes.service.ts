import { Injectable } from '@nestjs/common';
import { ClassNotFoundError } from '../../common/errors/class-not-found.error';
import {
  toClassResponse,
  toRosterResponse,
} from './trial-class.mapper';
import { ClassResponseDto } from './dto/class-response.dto';
import { RosterResponseDto } from './dto/roster-response.dto';
import { TrialClassesRepository } from './trial-classes.repository';

@Injectable()
export class TrialClassesService {
  constructor(private readonly repo: TrialClassesRepository) {}

  async listUpcoming(): Promise<ClassResponseDto[]> {
    const rows = await this.repo.listUpcomingWithSeatsLeft();
    return rows.map(toClassResponse);
  }

  async getRoster(classId: string): Promise<RosterResponseDto> {
    const cls = await this.repo.findById(classId);
    if (!cls) throw new ClassNotFoundError();
    const rows = await this.repo.listConfirmedRoster(classId);
    return toRosterResponse(classId, cls.subject, rows);
  }
}
