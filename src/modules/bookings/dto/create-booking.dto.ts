import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { SimulatePayment } from '../../../common/enums/simulate-payment.enum';

export class CreateBookingDto {
  @IsUUID('4')
  parentId!: string;

  @IsUUID('4')
  childId!: string;

  @IsUUID('4')
  classId!: string;

  @IsOptional()
  @IsEnum(SimulatePayment)
  simulatePayment: SimulatePayment = SimulatePayment.Success;
}
