import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

/**
 * Utilitários geográficos para a cerca digital.
 *
 * O cálculo de "ponto dentro do polígono" usa o Turf.js em vez de ray casting
 * escrito à mão: a implementação da biblioteca cobre casos que uma versão
 * ingênua erra (buracos no polígono, ponto exatamente sobre a aresta/vértice)
 * e faz pré-filtro por bounding box antes do teste geométrico.
 *
 * ATENÇÃO ao formato de coordenadas: aqui dentro trabalhamos com `{ lat, lng }`,
 * que é o formato que o resto do backend usa (`Tracker.lastLatitude` etc.), mas
 * o Turf segue o GeoJSON, que é `[lng, lat]`. A conversão acontece em um único
 * ponto (toPosition/fromPosition) para que essa inversão não vaze para a regra
 * de negócio — trocar lat por lng de forma silenciosa é o erro clássico que
 * coloca o veículo no lugar errado do mapa sem nenhum aviso.
 */

export interface GeoVertex {
  lat: number;
  lng: number;
}

/** Tipo posição do GeoJSON: [longitude, latitude]. */
type Position = [number, number];

const MIN_VERTICES = 3;
const COORD_PRECISION = 6;

function toPosition(vertex: GeoVertex): Position {
  return [vertex.lng, vertex.lat];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidVertex(value: unknown): value is GeoVertex {
  if (!value || typeof value !== 'object') return false;
  const { lat, lng } = value as Partial<GeoVertex>;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Arredonda para 6 casas (~11 cm), a mesma precisão de `Tracker.lastLatitude`. */
function roundCoordinate(value: number): number {
  return Number(value.toFixed(COORD_PRECISION));
}

/**
 * Valida a estrutura de um polígono vindo de fora (body HTTP, Json do banco).
 * Não confia no formato: só aceita o que é comprovadamente um array de vértices
 * numéricos dentro dos limites válidos de latitude/longitude.
 */
export function parsePolygon(value: unknown): GeoVertex[] | null {
  if (!Array.isArray(value) || value.length < MIN_VERTICES) return null;
  if (!value.every(isValidVertex)) return null;
  return value.map((v) => ({ lat: roundCoordinate(v.lat), lng: roundCoordinate(v.lng) }));
}

/**
 * Normaliza um polígono para gravação:
 *  - valida quantidade e faixa de coordenadas;
 *  - arredonda para 6 casas;
 *  - remove o ponto de fecho duplicado, porque o anel fechado é requisito do
 *    GeoJSON/PostGIS mas é detalhe de armazenamento — guardamos a lista "aberta"
 *    e fechamos o anel apenas na hora de entregar ao Turf.
 *
 * Lança se o polígono for inválido: a validação de entrada do DTO já barra a
 * maioria dos casos, então chegar aqui com lixo significa bug de chamada, não
 * erro de usuário.
 */
export function normalizePolygon(value: unknown): GeoVertex[] {
  const parsed = parsePolygon(value);
  if (!parsed) {
    throw new Error('Polígono inválido: são necessários ao menos 3 vértices com lat/lng válidos.');
  }
  const first = parsed[0];
  const last = parsed[parsed.length - 1];
  if (first.lat === last.lat && first.lng === last.lng) {
    const trimmed = parsed.slice(0, -1);
    // Depois de remover o fecho ainda têm de sobrar ≥3 vértices distintos. Um
    // input degenerado como [A, B, A] passaria pelo ArrayMinSize(3) do DTO mas
    // viraria um "polígono" de 2 vértices, que o teste de contenção rejeita —
    // a cerca ficaria gravada e silenciosamente inerte. Melhor recusar.
    if (trimmed.length < MIN_VERTICES) {
      throw new Error('Polígono inválido: são necessários ao menos 3 vértices distintos.');
    }
    return trimmed;
  }
  return parsed;
}

/**
 * Fecha o anel como o GeoJSON exige (primeiro ponto repetido no fim).
 * O Turf aceita anel aberto, mas fechamos por consistência — se um dia isso for
 * para o PostGIS, `ST_GeomFromGeoJSON` rejeita anéis abertos.
 */
function closeRing(vertices: GeoVertex[]): Position[] {
  const ring = vertices.map(toPosition);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return ring;
}

/**
 * Verifica se o ponto está dentro do polígono.
 *
 * Ponto exatamente sobre a aresta conta como DENTRO (`ignoreBoundary: false`,
 * o padrão do Turf). É a escolha deliberada para cerca digital: um veículo
 * parado sobre a linha da cerca não deve gerar alertas alternados de
 * entrada/saída a cada ping por ruído de GPS.
 */
export function isPointInPolygon(point: GeoVertex, vertices: GeoVertex[]): boolean {
  if (!isValidVertex(point) || !Array.isArray(vertices) || vertices.length < MIN_VERTICES) {
    return false;
  }
  if (!vertices.every(isValidVertex)) {
    // Dado corrompido no banco: trata como "fora" em vez de derrubar a ingestão
    // de um webhook. Devolver false é o lado seguro (não dispara alerta falso).
    return false;
  }
  const polygon = {
    type: 'Polygon' as const,
    coordinates: [closeRing(vertices)],
  };
  return booleanPointInPolygon(toPosition(point), polygon);
}

/**
 * Só os vértices/coordenadas de um polígono são usados aqui; este helper existe
 * para deixar explícito quando o valor Json veio do banco e pode estar
 * corrompido, em vez de espalhar `as GeoVertex[]` pelo serviço.
 */
export function readPolygonFromJson(value: unknown): GeoVertex[] | null {
  return parsePolygon(value);
}
