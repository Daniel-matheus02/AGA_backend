import { IsDateString, IsIn, IsString, MinLength } from 'class-validator';
export class PaymentWebhookDto {
  @IsString() @MinLength(8) providerReference:string;
  @IsIn(['PAID','FAILED','REVERSED']) status:'PAID'|'FAILED'|'REVERSED';
  @IsDateString() occurredAt:string;
}
