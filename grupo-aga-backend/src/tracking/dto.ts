import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

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

  // Cor da cerca no mapa, em hex `#rrggbb`. É livre (não uma lista fechada)
  // porque a paleta vive no frontend: fixá-la aqui obrigaria a um deploy do
  // backend sempre que a paleta ganhasse um tom novo. O que o backend precisa de
  // garantir é o FORMATO — uma cor inválida o Google Maps ignora em silêncio e a
  // cerca ficaria invisível sem erro nenhum.
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color deve estar no formato #rrggbb' }) color?:string;

  // 3 é o mínimo geométrico para formar área; 200 evita que um payload gigante
  // seja aceito e passe a ser reavaliado a cada ping de GPS.
  @IsArray() @ArrayMinSize(3) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => GeoVertexDto)
  vertices:GeoVertexDto[];

  @IsOptional() @IsBoolean() active?:boolean;
}

/**
 * Edição de uma cerca existente.
 *
 * Todos os campos são opcionais de propósito: a UI usa este DTO tanto para renomear
 * como para trocar a cor ou mover os vértices, e exigir o payload completo
 * obrigaria o frontend a reenviar dados que não quer alterar — abrindo a porta a
 * perder alterações feitas noutro separador.
 *
 * `kind` NÃO está aqui. Trocar POLYGON por um tipo que o cálculo de contenção não
 * sabe interpretar deixaria a cerca a existir sem nunca disparar alerta; quando a
 * cerca circular entrar, terá o seu próprio caminho com validação de geometria.
 *
 * O estado `inside/outside` por rastreador (TrackerGeofenceState) não é tocado por
 * uma edição: mover os vértices é uma mudança do referencial, não do veículo, e é
 * o próximo ping que decide se houve transição. Apagar esse estado faria os
 * veículos que já estão dentro gerarem um alerta de ENTRADA espúrio.
 */
export class UpdateGeofenceDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) name?:string;

  // Mesmo formato do CreateGeofenceDto — a regra de hex mora num sítio só, e aqui
  // repete-se a expressão porque o decorator precisa dela em tempo de classe.
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color deve estar no formato #rrggbb' }) color?:string;

  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => GeoVertexDto)
  vertices?:GeoVertexDto[];

  @IsOptional() @IsBoolean() active?:boolean;
}
