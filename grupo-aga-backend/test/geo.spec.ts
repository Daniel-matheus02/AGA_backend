import {
  isPointInPolygon,
  normalizePolygon,
  parsePolygon,
  readPolygonFromJson,
  GeoVertex,
} from '../src/tracking/geo';

// Quadrado em torno de Manaus. O sentido dos vértices é anti-horário; o Turf
// aceita ambos, mas fixamos um para o teste ser determinístico.
const SQUARE: GeoVertex[] = [
  { lat: -3.10, lng: -60.05 },
  { lat: -3.20, lng: -60.05 },
  { lat: -3.20, lng: -59.95 },
  { lat: -3.10, lng: -59.95 },
];

describe('geo — isPointInPolygon', () => {
  it('detecta ponto claramente dentro do polígono', () => {
    expect(isPointInPolygon({ lat: -3.15, lng: -60.0 }, SQUARE)).toBe(true);
  });

  it('detecta ponto claramente fora do polígono', () => {
    expect(isPointInPolygon({ lat: -3.5, lng: -60.0 }, SQUARE)).toBe(false);
  });

  it('detecta ponto fora por pouco (logo além da aresta)', () => {
    expect(isPointInPolygon({ lat: -3.15, lng: -60.0501 }, SQUARE)).toBe(false);
  });

  // Decisão deliberada: ponto sobre a aresta conta como DENTRO, porque o GPS
  // oscila alguns metros e alternar alertas a cada ping seria ruído.
  it('ponto exatamente sobre a aresta conta como dentro', () => {
    expect(isPointInPolygon({ lat: -3.15, lng: -60.05 }, SQUARE)).toBe(true);
  });

  it('ponto exatamente sobre um vértice conta como dentro', () => {
    expect(isPointInPolygon({ lat: -3.10, lng: -60.05 }, SQUARE)).toBe(true);
  });

  it('não confunde lat com lng (guarda contra a inversão GeoJSON)', () => {
    // Coordenadas trocadas caem fora; se o helper invertesse os eixos, daria true.
    expect(isPointInPolygon({ lat: -60.0, lng: -3.15 }, SQUARE)).toBe(false);
  });

  it('funciona com polígono côncavo', () => {
    // "L" que exclui o canto sudeste.
    const concave: GeoVertex[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 10 },
      { lat: 4, lng: 10 },
      { lat: 4, lng: 4 },
      { lat: 10, lng: 4 },
      { lat: 10, lng: 0 },
    ];
    expect(isPointInPolygon({ lat: 2, lng: 2 }, concave)).toBe(true);
    expect(isPointInPolygon({ lat: 8, lng: 8 }, concave)).toBe(false);
  });

  it('devolve false (não lança) com dado corrompido', () => {
    expect(isPointInPolygon({ lat: -3.15, lng: -60.0 }, [])).toBe(false);
    expect(isPointInPolygon({ lat: -3.15, lng: -60.0 }, [{ lat: 1, lng: 2 }])).toBe(false);
    // Vértice não numérico vindo de Json adulterado.
    expect(isPointInPolygon({ lat: -3.15, lng: -60.0 }, [{ lat: 'x', lng: 2 } as any, { lat: 1, lng: 2 }, { lat: 3, lng: 4 }])).toBe(false);
  });

  it('devolve false para coordenada de ponto inválida', () => {
    expect(isPointInPolygon({ lat: NaN, lng: -60.0 }, SQUARE)).toBe(false);
    expect(isPointInPolygon({ lat: 999, lng: -60.0 }, SQUARE)).toBe(false);
  });
});

describe('geo — parsePolygon', () => {
  it('aceita polígono válido', () => {
    expect(parsePolygon(SQUARE)).toHaveLength(4);
  });

  it('rejeita menos de 3 vértices', () => {
    expect(parsePolygon([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }])).toBeNull();
  });

  it('rejeita não-array e null', () => {
    expect(parsePolygon(null)).toBeNull();
    expect(parsePolygon('[]')).toBeNull();
    expect(parsePolygon(undefined)).toBeNull();
  });

  it('rejeita coordenadas fora da faixa válida', () => {
    expect(parsePolygon([{ lat: -91, lng: 0 }, { lat: 1, lng: 2 }, { lat: 3, lng: 4 }])).toBeNull();
    expect(parsePolygon([{ lat: 0, lng: -181 }, { lat: 1, lng: 2 }, { lat: 3, lng: 4 }])).toBeNull();
  });

  it('rejeita vértice sem lat/lng numérico', () => {
    expect(parsePolygon([{ lat: 'a', lng: 2 }, { lat: 1, lng: 2 }, { lat: 3, lng: 4 }])).toBeNull();
  });

  it('arredonda para 6 casas', () => {
    const parsed = parsePolygon([
      { lat: -3.123456789, lng: -60.987654321 },
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
    ]);
    expect(parsed?.[0]).toEqual({ lat: -3.123457, lng: -60.987654 });
  });

  it('readPolygonFromJson é o caminho para o Json do banco', () => {
    expect(readPolygonFromJson(SQUARE)).toHaveLength(4);
    expect(readPolygonFromJson({ qualquer: 'coisa' })).toBeNull();
  });
});

describe('geo — normalizePolygon', () => {
  it('remove ponto de fecho duplicado ao gravar', () => {
    const closed = [...SQUARE, SQUARE[0]];
    expect(normalizePolygon(closed)).toHaveLength(4);
  });

  it('mantém triângulo fechado com 3 vértices distintos + fecho', () => {
    const tri = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 0 }, { lat: 0, lng: 0 }];
    expect(normalizePolygon(tri)).toHaveLength(3);
  });

  it('recusa triângulo degenerado (3 vértices, último repete o primeiro)', () => {
    // [A,B,A] passaria pelo ArrayMinSize(3) do DTO, mas sobrariam só 2 vértices
    // distintos: gravar isso criaria uma cerca silenciosamente inerte.
    const degen = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 0, lng: 0 }];
    expect(() => normalizePolygon(degen)).toThrow(/3 vértices distintos/);
  });

  it('aceita triângulo legítimo com fecho (3 distintos + repetição)', () => {
    const tri = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 0 }, { lat: 0, lng: 0 }];
    expect(normalizePolygon(tri)).toHaveLength(3);
  });

  it('não confunde vértice coincidente acidental com fecho', () => {
    // 4 vértices onde o último não repete o primeiro: nada é removido.
    expect(normalizePolygon(SQUARE)).toHaveLength(4);
  });

  it('lança com polígono inválido', () => {
    expect(() => normalizePolygon([{ lat: 1, lng: 2 }])).toThrow();
    expect(() => normalizePolygon(null)).toThrow();
  });

  it('o polígono normalizado continua a funcionar no teste de contenção', () => {
    // Fecho duplicado removido na gravação e re-adicionado no cálculo: o
    // resultado da contenção não pode mudar por causa disso.
    const closed = [...SQUARE, SQUARE[0]];
    const normalized = normalizePolygon(closed);
    expect(isPointInPolygon({ lat: -3.15, lng: -60.0 }, normalized)).toBe(true);
    expect(isPointInPolygon({ lat: -3.15, lng: -60.0 }, closed)).toBe(true);
  });
});
