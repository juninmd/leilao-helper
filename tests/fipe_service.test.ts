import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FipeError, fipeErrorMessage, FipeService } from '../src/fipe_service';

const brands = [
  { nome: 'Fiat', valor: '21' },
  { nome: 'GM - Chevrolet', valor: '23' },
  { nome: 'Mercedes-Benz', valor: '39' },
  { nome: 'VW - VolksWagen', valor: '59' },
];
const models: Record<string, { modelo: string; valor: string }[]> = {
  '21': [
    { modelo: 'Uno Mille Economy 1.0 Fire Flex 8V 4p', valor: '100' },
    { modelo: 'Uno Mille 1.0 ', valor: '101' },
    { modelo: 'Palio Fire 1.0', valor: '102' },
  ],
  '59': [{ modelo: 'Gol City 1.0 Flex 8V 4p', valor: '200' }, { modelo: 'Gol 1.6 Mi', valor: '201' }],
};

function mockApi(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    for (const [part, make] of Object.entries(overrides)) if (url.includes(part)) return make();
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/marcas/v1/carros')) return json(brands);
    if (url.endsWith('/marcas/v1/motos')) return json([{ nome: 'HONDA', valor: '80' }]);
    if (url.endsWith('/marcas/v1/caminhoes')) return json([]);
    let m = url.match(/veiculos\/v1\/carros\/(\d+)$/);
    if (m) return json(models[m[1]] ?? []);
    if (/veiculos\/v1\/motos\/80$/.test(url)) return json([{ modelo: 'CG 160 FAN', valor: '900' }]);
    m = url.match(/models\/(\d+)\/years$/);
    if (m) return json([{ code: '2008-1', name: '2008 Gasolina' }, { code: '2009-1', name: '2009 Gasolina' }, { code: '2010-1', name: '2010 Gasolina' }]);
    m = url.match(/models\/(\d+)\/years\/(\d+)-1$/);
    if (m) return json({ price: `R$ ${m[2]},00`, brand: 'X', model: `M${m[1]}`, modelYear: Number(m[2]), fuel: 'Gasolina', codeFipe: '1', referenceMonth: 'outubro de 2026' });
    return json({}, 404);
  }));
  return calls;
}

beforeEach(() => FipeService.clearCache());
afterEach(() => vi.unstubAllGlobals());

describe('FipeService.normalize', () => {
  it('removes accents, keeps engine sizes', () => {
    expect(FipeService.normalize('Opala Comodoro 4.1 Álcool')).toBe('opala comodoro 4.1 alcool');
    expect(FipeService.normalize('M.BENZ')).toBe('m benz');
  });
});

describe('FipeService catalog (picker data)', () => {
  const cars = FipeService.CATEGORIES[0];

  it('lists brands and models with trimmed names, dropping malformed entries', async () => {
    mockApi({ '/marcas/v1/carros': () => new Response(JSON.stringify([{ nome: ' Fiat ', valor: '21' }, { nome: '', valor: '1' }, null]), { status: 200 }) });
    expect(await FipeService.listBrands(cars)).toEqual([{ name: 'Fiat', code: '21' }]);
    FipeService.clearCache();
    mockApi();
    expect((await FipeService.listModels(cars, '21'))[1]).toEqual({ name: 'Uno Mille 1.0', code: '101' });
  });

  it('lists years newest first', async () => {
    mockApi();
    const years = await FipeService.listYears(cars, '21', '100');
    expect(years.map(y => y.code)).toEqual(['2010-1', '2009-1', '2008-1']);
  });

  it('prices an exact selection without any name matching', async () => {
    const calls = mockApi();
    const r = await FipeService.getPriceByCode(cars, '21', '102', '2009-1');
    expect(r.model).toBe('M102');
    expect(calls.some(u => u.includes('/veiculos/'))).toBe(false);
  });

  it('resolves an auction description to category, brand and best model', async () => {
    mockApi();
    expect(await FipeService.resolveVehicle('VW', 'GOL 1.6')).toMatchObject({ category: { brasil: 'carros' }, brandCode: '59', modelCode: '201' });
    expect(await FipeService.resolveVehicle('HONDA', 'CG 160 FAN')).toMatchObject({ category: { brasil: 'motos' }, modelCode: '900' });
  });

  it('keeps the brand when the model is unknown, and returns null for unknown brands', async () => {
    mockApi();
    expect(await FipeService.resolveVehicle('FIAT', 'NAVE ESPACIAL')).toMatchObject({ brandCode: '21', modelCode: null });
    expect(await FipeService.resolveVehicle('XPTO', 'UNO')).toBeNull();
  });

  describe('resolveVehicle with a model year (picker prefill must agree with the automatic lookup)', () => {
    const only2015 = () => new Response(JSON.stringify([{ code: '2015-1', name: '2015 Gasolina' }]), { status: 200 });

    it('walks the ranked variants until one has the year, instead of trusting the top-ranked name', async () => {
      mockApi({ '/models/101/years': only2015 }); // best-ranked "Uno Mille 1.0" has no 2009
      expect(await FipeService.resolveVehicle('FIAT', 'UNO MILLE', 2009)).toMatchObject({ modelCode: '100', yearCode: '2009-1' });
    });

    it('lands on the same vehicle getPrice prices', async () => {
      mockApi({ '/models/101/years': only2015 });
      const hit = await FipeService.resolveVehicle('FIAT', 'UNO MILLE', 2009);
      const priced = await FipeService.getPrice('FIAT', 'UNO MILLE', 2009);
      expect(`M${hit?.modelCode}`).toBe(priced?.model);
    });

    it('falls back to the adjacent year', async () => {
      mockApi();
      expect(await FipeService.resolveVehicle('FIAT', 'UNO MILLE', 2011)).toMatchObject({ yearCode: '2010-1' });
    });

    it('keeps brand and model when the years endpoint fails (BrasilAPI still serves them)', async () => {
      mockApi({ '/years': () => new Response('{}', { status: 429 }) });
      const hit = await FipeService.resolveVehicle('FIAT', 'UNO MILLE', 2009);
      expect(hit).toMatchObject({ brandCode: '21', modelCode: '101' });
      expect(hit?.yearCode).toBeUndefined();
    });

    it('still returns brand and best model, without a year, when no variant has it', async () => {
      mockApi();
      const hit = await FipeService.resolveVehicle('FIAT', 'UNO MILLE', 1990);
      expect(hit).toMatchObject({ brandCode: '21', modelCode: '101' });
      expect(hit?.yearCode).toBeUndefined();
    });
  });

  it('surfaces rate limiting on the years endpoint', async () => {
    mockApi({ '/years': () => new Response('{}', { status: 429 }) });
    await expect(FipeService.listYears(cars, '21', '100')).rejects.toMatchObject({ kind: 'rate-limit' });
  });
});

describe('FipeService.getPrice', () => {
  it('finds exact year using real API field names (modelo/valor, code, price)', async () => {
    mockApi();
    const r = await FipeService.getPrice('FIAT', 'UNO MILLE ECONOMY', 2009);
    expect(r?.modelYear).toBe(2009);
    expect(r?.model).toBe('M100');
  });

  it('resolves auction abbreviations (VW, GM, M.BENZ)', async () => {
    mockApi();
    expect((await FipeService.getPrice('VW', 'GOL 1.0 CITY', 2009))?.model).toBe('M200');
    expect(await FipeService.findBrand({ brasil: 'carros', parallelum: 'cars' }, 'GM')).toBe('23');
    expect(await FipeService.findBrand({ brasil: 'carros', parallelum: 'cars' }, 'M.BENZ')).toBe('39');
  });

  it('prefers the engine size in the model name', async () => {
    mockApi();
    expect((await FipeService.getPrice('VW', 'GOL 1.6', 2009))?.model).toBe('M201');
  });

  it('falls back to an adjacent year', async () => {
    mockApi();
    expect((await FipeService.getPrice('FIAT', 'UNO MILLE', 2011))?.modelYear).toBe(2010);
  });

  describe('approximate flag (the auction name did not pin the variant down)', () => {
    it('is false when the variant words matched', async () => {
      mockApi();
      expect((await FipeService.getPrice('FIAT', 'UNO MILLE ECONOMY', 2009))?.approximate).toBe(false);
    });
    it('is true when only the family word matched', async () => {
      mockApi();
      expect((await FipeService.getPrice('FIAT', 'PALIO', 2009))?.approximate).toBe(true);
    });
    it('is true when an adjacent year stood in', async () => {
      mockApi();
      expect((await FipeService.getPrice('FIAT', 'UNO MILLE ECONOMY', 2011))?.approximate).toBe(true);
    });
  });

  it('resolves import prefixes and truncated names end to end', async () => {
    mockApi();
    expect((await FipeService.getPrice('VW', 'GOL CIT 10', 2009))?.model).toBe('M200');
  });

  it('spends at most MAX_GUESSES years requests on family-only guesses', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ modelo: `Palio Variante ${i}`, valor: String(500 + i) }));
    const calls = mockApi({
      'veiculos/v1/carros/21': () => new Response(JSON.stringify(many), { status: 200 }),
      '/years': () => new Response(JSON.stringify([{ code: '2015-1', name: '2015 Gasolina' }]), { status: 200 }),
    });
    expect(await FipeService.getPrice('FIAT', 'PALIO', 2009)).toBeNull();
    expect(calls.filter(u => /years$/.test(u)).length).toBe(6);
  });

  it('tries the category whose model scores best first (a CB 300F is a motorcycle even if the car list has a CB)', async () => {
    mockApi({
      '/marcas/v1/carros': () => new Response(JSON.stringify([{ nome: 'HONDA', valor: '80' }]), { status: 200 }),
      'veiculos/v1/carros/80': () => new Response(JSON.stringify([{ modelo: 'CB Carro', valor: '950' }]), { status: 200 }),
      'veiculos/v1/motos/80': () => new Response(JSON.stringify([{ modelo: 'CB 300F Twister Flex', valor: '901' }]), { status: 200 }),
    });
    expect(await FipeService.resolveVehicle('HONDA', 'CB300F TWISTER')).toMatchObject({ category: { brasil: 'motos' }, modelCode: '901' });
  });

  it('skips trailers without a single request (FIPE does not price them)', async () => {
    const calls = mockApi();
    expect(await FipeService.getPrice('SR', 'FACCHINI SRF 4CB', 2020)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when the year is far away', async () => {
    mockApi();
    expect(await FipeService.getPrice('FIAT', 'UNO MILLE', 1990)).toBeNull();
  });

  it('returns null for unknown brand or model', async () => {
    mockApi();
    expect(await FipeService.getPrice('XPTO', 'UNO', 2009)).toBeNull();
    expect(await FipeService.getPrice('FIAT', 'NAVE ESPACIAL', 2009)).toBeNull();
  });

  it('falls through to motorcycles', async () => {
    mockApi();
    expect((await FipeService.getPrice('HONDA', 'CG 160 FAN', 2010))?.model).toBe('M900');
  });

  it('throws rate-limit when the price API answers 429 and nothing else matched', async () => {
    mockApi({ '/years': () => new Response('{}', { status: 429 }) });
    await expect(FipeService.getPrice('FIAT', 'UNO MILLE', 2009)).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('throws a network error when fetch rejects, and does not cache the failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(FipeService.getPrice('FIAT', 'UNO', 2009)).rejects.toBeInstanceOf(FipeError);
    mockApi();
    expect(await FipeService.getPrice('FIAT', 'UNO MILLE', 2009)).not.toBeNull();
  });

  it('dedupes concurrent requests', async () => {
    const calls = mockApi();
    await Promise.all([FipeService.getPrice('FIAT', 'UNO MILLE', 2009), FipeService.getPrice('FIAT', 'UNO MILLE', 2009)]);
    expect(calls.filter(u => u.endsWith('/marcas/v1/carros')).length).toBe(1);
  });

  it('sends the token only when provided', async () => {
    mockApi();
    await FipeService.getPrice('FIAT', 'UNO MILLE', 2009, 'abc');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const withHeader = fetchMock.mock.calls.filter(c => c[1]?.headers);
    expect(withHeader.length).toBeGreaterThan(0);
    expect(withHeader.every(c => c[0].includes('parallelum'))).toBe(true);
  });
});

describe('invalid token', () => {
  beforeEach(() => FipeService.clearCache());
  afterEach(() => vi.unstubAllGlobals());

  it('reports auth (not a connection problem) when the API rejects the token', async () => {
    mockApi({ '/years': () => new Response('{}', { status: 401 }) });
    const error = await FipeService.getPrice('FIAT', 'UNO MILLE', 2009, 'bad-token').catch(e => e);
    expect(error).toMatchObject({ kind: 'auth' });
    expect(fipeErrorMessage(error)).toMatch(/Token da API FIPE inválido/);
  });

  it('keeps 401 without a token as a network error', async () => {
    mockApi({ '/years': () => new Response('{}', { status: 401 }) });
    await expect(FipeService.getPrice('FIAT', 'UNO MILLE', 2009)).rejects.toMatchObject({ kind: 'network' });
  });
});
