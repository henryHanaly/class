export class ClassResponseDto {
  id!: string;
  subject!: string;
  startsAt!: string; // ISO
  capacity!: number;
  seatsLeft!: number;
  priceCents!: number; // list price in minor units; format client-side
}
