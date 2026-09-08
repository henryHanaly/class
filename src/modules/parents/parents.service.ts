import { Injectable } from '@nestjs/common';
import { ParentNotFoundError } from '../../common/errors/parent-not-found.error';
import { LookupParentDto } from './dto/lookup-parent.dto';
import { ParentLookupResponseDto } from './dto/parent-response.dto';
import { toParentLookupResponse } from './parent.mapper';
import { ParentsRepository } from './parents.repository';

@Injectable()
export class ParentsService {
  constructor(private readonly repo: ParentsRepository) {}

  // Identify step (HLD §4): resolve a seeded email to its parentId. 404 if
  // unseeded — it creates nothing and verifies nothing.
  async lookup(dto: LookupParentDto): Promise<ParentLookupResponseDto> {
    const parent = await this.repo.findByEmailWithChildren(dto.email);
    if (!parent) throw new ParentNotFoundError();
    return toParentLookupResponse(parent);
  }
}
