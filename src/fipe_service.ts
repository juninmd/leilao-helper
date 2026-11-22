import { fetchJson, fetchPersistent, FipeError, persistentStore } from './fipe_http';
import { NOT_IN_FIPE_MAKERS } from './depara';
import { normalize, pickBrand, rankModels, RankedModel } from './model_match';
import { FipeVehicle } from './types';

// Vehicle category as named by each API.
export interface Category {
  brasil: 'carros' | 'motos' | 'caminhoes';
  parallelum: 'cars' | 'motorcycles' | 'trucks';
  label: string;
}

export interface NamedCode { name: string; code: string }

export interface LocatedVehicle {
  category: Category;
  brandCode: string;
  modelCode: string;
  yearCode: string;
  /** The variant or the year is a best guess (only the model family matched, or an adjacent year was used). */
  approximate: boolean;
}

/** FIPE answer plus how sure the match was. */
export type PricedVehicle = FipeVehicle & { approximate: boolean };

export interface ResolvedVehicle { category: Category; brandCode: string; modelCode: string | null; yearCode?: string }

export { FipeError, fipeErrorMessage } from './fipe_http';

// FIPE lists many variants per model; only the best-ranked few are probed for the year (one request each).
// Guesses (only the family word matched) get fewer probes: they are the least likely to pay off.
const MAX_CANDIDATES = 15;
const MAX_GUESSES = 6;

export class FipeService {
  // Brands and models come from BrasilAPI (no rate limit); years and prices from the FIPE API v2 (ids are shared).
  static BRASIL_URL = 'https://brasilapi.com.br/api/fipe';
  static FIPE_URL = 'https://fipe.parallelum.com.br/api/v2';

  // Cars first — most common at auctions.
  static readonly CATEGORIES: readonly Category[] = [
    { brasil: 'carros', parallelum: 'cars', label: 'Carros' },
    { brasil: 'motos', parallelum: 'motorcycles', label: 'Motos' },
    { brasil: 'caminhoes', parallelum: 'trucks', label: 'Caminhões' },
  ];

  private static cache = new Map<string, Promise<unknown>>();

  static clearCache() {
    this.cache.clear();
  }

  static normalize(text: string): string {
    return normalize(text);
  }

  /** "Tentar novamente" means try the network now, even right after a 429. */
  static async retryNow() {
    await persistentStore()?.clearCooldown();
  }

  // Only the rate-limited FIPE v2 answers (years, prices) are persisted; BrasilAPI is not.
  private static getJson<T>(url: string, token?: string): Promise<T> {
    const key = url;
    const cached = this.cache.get(key);
    if (cached) return cached as Promise<T>;

    const store = url.startsWith(this.FIPE_URL) ? persistentStore() : null;
    const request = store
      ? fetchPersistent<T>(url, token, store, `${this.FIPE_URL}/references`).then(r => {
        if (r.stale) this.cache.delete(key); // an old answer must not shadow the network for the rest of the page's life
        return r.value;
      })
      : fetchJson<T>(url, token);

    this.cache.set(key, request);
    request.catch(() => this.cache.delete(key)); // never cache failures
    return request;
  }

  /** Finds the FIPE brand code matching an auction brand abbreviation. */
  static async findBrand(category: Category, brand: string): Promise<string | null> {
    const brands = await this.getJson<{ nome: string; valor: string }[]>(`${this.BRASIL_URL}/marcas/v1/${category.brasil}`);
    return pickBrand(brands, brand);
  }

  private static yearOf(code: string): number {
    return parseInt(code.split('-')[0], 10);
  }

  private static clean(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  /** All FIPE brands of a category, in API order. */
  static async listBrands(category: Category): Promise<NamedCode[]> {
    const brands = await this.getJson<{ nome: string; valor: string }[]>(`${this.BRASIL_URL}/marcas/v1/${category.brasil}`);
    if (!Array.isArray(brands)) return [];
    return brands.filter(b => b?.nome && b?.valor).map(b => ({ name: this.clean(b.nome), code: String(b.valor) })).filter(b => b.name);
  }

  /** All FIPE models of a brand (several hundred for big brands — filter client-side). */
  static async listModels(category: Category, brandCode: string): Promise<NamedCode[]> {
    const models = await this.getJson<{ modelo: string; valor: string }[]>(`${this.BRASIL_URL}/veiculos/v1/${category.brasil}/${brandCode}`);
    if (!Array.isArray(models)) return [];
    return models.filter(m => m?.modelo && m?.valor).map(m => ({ name: this.clean(m.modelo), code: String(m.valor) })).filter(m => m.name);
  }

  /** Model years (one entry per fuel) of a model, newest first. */
  static async listYears(category: Category, brandCode: string, modelCode: string, token?: string): Promise<NamedCode[]> {
    const years = await this.getJson<NamedCode[]>(`${this.FIPE_URL}/${category.parallelum}/brands/${brandCode}/models/${modelCode}/years`, token);
    if (!Array.isArray(years)) return [];
    return years
      .filter(y => y?.code && y?.name)
      .sort((a, b) => this.yearOf(b.code) - this.yearOf(a.code) || a.code.localeCompare(b.code));
  }

  /** Exact lookup from picker codes; no name matching involved. */
  static getPriceByCode(category: Category, brandCode: string, modelCode: string, yearCode: string, token?: string): Promise<FipeVehicle> {
    return this.getJson<FipeVehicle>(
      `${this.FIPE_URL}/${category.parallelum}/brands/${brandCode}/models/${modelCode}/years/${yearCode}`, token);
  }

  /**
   * FIPE models that may be the auction vehicle, per category, best category first. Only BrasilAPI is used here (no FIPE quota).
   * Failures of one category do not hide the others; the last one is reported when nothing at all was found.
   */
  private static async candidatePools(brand: string, model: string): Promise<{ pools: { category: Category; brandCode: string; ranked: RankedModel[] }[]; error: FipeError | null }> {
    const pools: { category: Category; brandCode: string; ranked: RankedModel[] }[] = [];
    let error: FipeError | null = null;
    for (const category of this.CATEGORIES) {
      try {
        const brandCode = await this.findBrand(category, brand);
        if (!brandCode) continue;
        const models = await this.getJson<{ modelo: string; valor: string }[]>(`${this.BRASIL_URL}/veiculos/v1/${category.brasil}/${brandCode}`);
        const ranked = rankModels(models, model, MAX_CANDIDATES, brand);
        if (ranked.length) pools.push({ category, brandCode, ranked });
      } catch (e) {
        if (e instanceof FipeError) error = e; else throw e;
      }
    }
    // The best-scoring category first (a Honda "CB 300F" is a motorcycle, not a car); ties keep the category order.
    pools.sort((a, b) => b.ranked[0].score - a.ranked[0].score);
    return { pools, error };
  }

  /**
   * Finds the FIPE codes for an auction vehicle: the first ranked variant that has the model year
   * (closest adjacent year as a fallback). Null when nothing matches; throws FipeError when the API
   * failed and nothing was found.
   */
  static async locate(brand: string, model: string, year: number, token?: string): Promise<LocatedVehicle | null> {
    if (NOT_IN_FIPE_MAKERS.has(normalize(brand))) return null; // trailers: FIPE has no price, so spend no quota
    const { pools, error } = await this.candidatePools(brand, model);
    let lastError = error;
    let guesses = 0; // shared by all categories so the cap protects the daily quota per lot

    for (const { category, brandCode, ranked } of pools) {
      try {
        // Walk the ranked variants until one has the exact model year; remember the closest adjacent year meanwhile.
        let adjacent: { candidate: RankedModel; code: string } | null = null;
        for (const candidate of ranked) {
          if (candidate.approximate && ++guesses > MAX_GUESSES) break;
          const years = await this.getJson<NamedCode[]>(
            `${this.FIPE_URL}/${category.parallelum}/brands/${brandCode}/models/${candidate.valor}/years`, token);
          if (!Array.isArray(years)) continue;

          const exact = years.find(y => this.yearOf(y.code) === year);
          if (exact) return { category, brandCode, modelCode: candidate.valor, yearCode: exact.code, approximate: candidate.approximate };

          for (const delta of [-1, 1]) {
            const near = years.find(y => this.yearOf(y.code) === year + delta);
            if (near && !adjacent) adjacent = { candidate, code: near.code };
          }
        }

        if (adjacent) return { category, brandCode, modelCode: adjacent.candidate.valor, yearCode: adjacent.code, approximate: true };
      } catch (e) {
        if (e instanceof FipeError) lastError = e;
        else throw e;
      }
    }

    if (lastError) throw lastError;
    return null;
  }

  /**
   * Maps an auction brand/model (and model year) to FIPE codes for the picker. With a year it agrees with
   * getPrice; without a match it still returns the brand and best-named model so the user can finish the choice.
   */
  static async resolveVehicle(brand: string, model: string, year?: number, token?: string): Promise<ResolvedVehicle | null> {
    if (year !== undefined) {
      try {
        const hit = await this.locate(brand, model, year, token);
        if (hit) return hit;
      } catch (e) {
        // A failing years endpoint (e.g. 429) must not hide brand and model, which BrasilAPI still serves.
        if (!(e instanceof FipeError)) throw e;
      }
    }

    const { pools } = await this.candidatePools(brand, model);
    if (pools.length) return { category: pools[0].category, brandCode: pools[0].brandCode, modelCode: pools[0].ranked[0].valor };
    for (const category of this.CATEGORIES) {
      const brandCode = await this.findBrand(category, brand);
      if (brandCode) return { category, brandCode, modelCode: null };
    }
    return null;
  }

  /** Looks up the FIPE price. Returns null when nothing matches; throws FipeError when the API is unreachable or rate-limited. */
  static async getPrice(brand: string, model: string, year: number, token?: string): Promise<PricedVehicle | null> {
    const hit = await this.locate(brand, model, year, token);
    if (!hit) return null;
    const price = await this.getPriceByCode(hit.category, hit.brandCode, hit.modelCode, hit.yearCode, token);
    return { ...price, approximate: hit.approximate };
  }
}
