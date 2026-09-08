import { seatsLeft } from './seat.policy';
import { ClassResponseDto } from './dto/class-response.dto';
import { RosterResponseDto } from './dto/roster-response.dto';
import {
  ClassWithSeatsLeft,
  RosterRow,
} from './trial-classes.repository';

export function toClassResponse(row: ClassWithSeatsLeft): ClassResponseDto {
  const capacity = Number(row.capacity);
  const confirmed = capacity - Number(row.seats_left);
  return {
    id: row.id,
    subject: row.subject,
    startsAt: row.starts_at.toISOString(),
    capacity,
    seatsLeft: seatsLeft(capacity, confirmed),
    priceCents: Number(row.price_cents),
  };
}

export function toRosterResponse(
  classId: string,
  subject: string,
  rows: RosterRow[],
): RosterResponseDto {
  return {
    classId,
    subject,
    students: rows.map((r) => ({
      childId: r.child_id,
      name: r.name,
      grade: r.grade,
      bookedAt: r.booked_at.toISOString(),
    })),
  };
}
