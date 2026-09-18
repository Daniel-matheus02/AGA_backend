import { IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';
export class CreateProductDto {
  @IsString() @MinLength(3) name:string;
  @IsOptional() @IsString() description?:string;
  @IsString() @MinLength(2) category:string;
  @IsInt() @Min(100) @Max(500000) priceCents:number;
}
export class AdminCreateProductDto {
  @IsUUID() merchantId:string;
  @IsString() @MinLength(3) name:string;
  @IsOptional() @IsString() description?:string;
  @IsString() @MinLength(2) category:string;
  @IsInt() @Min(100) @Max(500000) priceCents:number;
}
export class CreateCategoryDto { @IsString() @MinLength(2) name:string; }
export class CreateOrderDto {
  @IsUUID() productId:string;
  @IsOptional() @IsUUID() clientId?:string;
}
