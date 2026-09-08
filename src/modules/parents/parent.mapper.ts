import { Child, Parent } from '@prisma/client';
import { ParentLookupResponseDto } from './dto/parent-response.dto';

export function toParentLookupResponse(
  parent: Parent & { children: Child[] },
): ParentLookupResponseDto {
  return {
    parentId: parent.id,
    name: parent.name,
    children: parent.children.map((c) => ({
      id: c.id,
      name: c.name,
      grade: c.grade,
    })),
  };
}
