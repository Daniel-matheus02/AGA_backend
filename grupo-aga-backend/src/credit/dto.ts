import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
export class CreateCreditRequestDto {
  @IsInt() @Min(30000) @Max(1000000) amountCents:number;
  @IsInt() @Min(10) @Max(180) dailyInstallments:number;
}
export class DecideCreditRequestDto {
  @IsInt() @Min(30000) @Max(1000000) approvedLimitCents:number;
  @IsOptional() @IsString() @MinLength(3) reason?:string;
}
export class RejectCreditRequestDto { @IsString() @MinLength(3) reason:string; }
