import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

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

/**
 * Vértice de um polígono de cerca. Os limites de lat/lng são os mesmos usados no
 * TrackingIngestDto, para que um vértice inválido seja rejeitado na borda da API
 * em vez de virar um polígono que nunca contém nada.
 */
export class GeoVertexDto {
  @IsNumber() @Min(-90) @Max(90) lat:number;
  @IsNumber() @Min(-180) @Max(180) lng:number;
}

export class CreateGeofenceDto {
  @IsString() @MinLength(3) @MaxLength(120) name:string;

  // Só POLYGON por enquanto. O campo existe para o dia em que a cerca circular
  // entrar sem precisar de migration — mas hoje qualquer outro valor é rejeitado,
  // em vez de gravar um `kind` que o cálculo de contenção não sabe interpretar.
  @IsOptional() @IsIn(['POLYGON']) kind?:string;

  // 3 é o mínimo geométrico para formar área; 200 evita que um payload gigante
  // seja aceito e passe a ser reavaliado a cada ping de GPS.
  @IsArray() @ArrayMinSize(3) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => GeoVertexDto)
  vertices:GeoVertexDto[];

  @IsOptional() @IsBoolean() active?:boolean;
}
