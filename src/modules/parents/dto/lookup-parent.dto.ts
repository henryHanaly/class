import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

export class LookupParentDto {
  @IsEmail()
  @MaxLength(320)
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email!: string;
}
