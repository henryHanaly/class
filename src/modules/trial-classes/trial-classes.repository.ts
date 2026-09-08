import { Injectable } from '@nestjs/common';
import { TrialClass } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface ClassWithSeatsLeft {
  id: string;
  subject: string;
  starts_at: Date;
  capacity: number;
  price_cents: number;
  seats_left: number;
}

export interface RosterRow {
  child_id: string;
  name: string;
  grade: string | null;
  booked_at: Date;
}

@Injectable()
export class TrialClassesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // One query, no N+1 (HLD §14).
  listUpcomingWithSeatsLeft(): Promise<ClassWithSeatsLeft[]> {
    return this.prisma.$queryRaw<ClassWithSeatsLeft[]>`
      SELECT c.id, c.subject, c.starts_at, c.capacity, c.price_cents,
             c.capacity - COALESCE(b.confirmed, 0) AS seats_left
      FROM trial_classes c
      LEFT JOIN (
        SELECT class_id, COUNT(*)::int AS confirmed
        FROM bookings WHERE status = 'confirmed' GROUP BY class_id
      ) b ON b.class_id = c.id
      WHERE c.starts_at > now()
      ORDER BY c.starts_at`;
  }

  findById(id: string): Promise<TrialClass | null> {
    return this.prisma.trialClass.findUnique({ where: { id } });
  }

  listConfirmedRoster(classId: string): Promise<RosterRow[]> {
    return this.prisma.$queryRaw<RosterRow[]>`
      SELECT ch.id AS child_id, ch.name, ch.grade, b.created_at AS booked_at
      FROM bookings b
      JOIN children ch ON ch.id = b.child_id
      WHERE b.class_id = ${classId}::uuid AND b.status = 'confirmed'
      ORDER BY b.created_at`;
  }
}
