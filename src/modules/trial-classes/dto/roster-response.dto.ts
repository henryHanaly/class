export class RosterResponseDto {
  classId!: string;
  subject!: string;
  students!: {
    childId: string;
    name: string;
    grade: string | null;
    bookedAt: string;
  }[];
}
