import { IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
export class TrackingIngestDto {
  @IsString() @MinLength(3) trackerExternalId:string;
  @IsNumber() @Min(-90) @Max(90) latitude:number;
  @IsNumber() @Min(-180) @Max(180) longitude:number;
  @IsNumber() @Min(0) @Max(350) speedKph:number;
  @IsOptional() @IsInt() @Min(0) @Max(359) heading?:number;
  @IsOptional() @IsBoolean() ignitionOn?:boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) batteryPct?:number;
  @IsDateString() recordedAt:string;
}
