import { Injectable } from '@nestjs/common';
import { Child, Parent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ParentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmailWithChildren(
    email: string,
  ): Promise<(Parent & { children: Child[] }) | null> {
    return this.prisma.parent.findUnique({
      where: { email },
      include: { children: true },
    });
  }
}
