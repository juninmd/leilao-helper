import { chromeBackend, PersistentCache } from './persistent_cache';
import { FipeErrorKind } from './types';

export class FipeError extends Error {
  constructor(public kind: FipeErrorKind, message: string) {
    super(message);
    this.name = 'FipeError';
  }
}

const REQUEST_TIMEOUT_MS = 15000;

// Absent outside an extension (unit tests), so the plain network path stays testable.
let store: PersistentCache | null = null;
let storeReady = false;

/** Swaps the persistent store (tests); null disables it. */
export function useStore(next: PersistentCache | null) {
  store = next;
  storeReady = true;
}

export function persistentStore(): PersistentCache | null {
  if (!storeReady) {
    const backend = chromeBackend();
    store = backend ? new PersistentCache(backend) : null;
    storeReady = true;
    const cache = store;
    if (cache) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local') cache.applyChanges(changes); });
  }
  return store;
}

export async function fetchJson<T>(url: string, token?: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: token ? { 'X-Subscription-Token': token } : undefined,
    });
    if (res.status === 429) throw new FipeError('rate-limit', 'Limite de consultas da API FIPE excedido');
    if (token && (res.status === 401 || res.status === 403)) throw new FipeError('auth', 'Token da API FIPE inválido ou expirado');
    if (!res.ok) throw new FipeError('network', `API FIPE respondeu ${res.status}`);
    return await res.json() as T;
  } catch (e) {
    if (e instanceof FipeError) throw e;
    throw new FipeError('network', 'Falha ao acessar a API FIPE');
  } finally {
    clearTimeout(timer);
  }
}

const rateLimited = () => new FipeError('rate-limit', 'Limite de consultas da API FIPE excedido');

/** One counted, cooldown-aware request to the rate-limited API. A 429 starts the cooldown. */
async function spend<T>(url: string, token: string | undefined, cache: PersistentCache): Promise<T> {
  const authed = !!token;
  if (await cache.coolingDown(authed)) throw rateLimited(); // outside the try: a skipped request must not extend the cooldown
  void cache.recordRequest(authed);
  try {
    return await fetchJson<T>(url, token);
  } catch (e) {
    if (e instanceof FipeError && e.kind === 'rate-limit') await cache.startCooldown(authed);
    throw e;
  }
}

const checking = new WeakMap<PersistentCache, Promise<void>>();
const lastFailure = new WeakMap<PersistentCache, number>();
const RETRY_CHECK_MS = 60_000;

/** Learns which FIPE table is current (newest code first in the list), so month-old answers stay valid all month. */
function refreshReference(referencesUrl: string, token: string | undefined, cache: PersistentCache): Promise<void> {
  let pending = checking.get(cache);
  if (!pending) {
    pending = (async () => {
      if (!await cache.needsReferenceCheck()) return;
      if (Date.now() - (lastFailure.get(cache) ?? 0) < RETRY_CHECK_MS) return; // do not retry a failing check on every lookup
      try {
        const list = await spend<{ code: string }[]>(referencesUrl, token, cache);
        const newest = (Array.isArray(list) ? list : []).map(r => Number(r?.code)).filter(Number.isFinite).sort((a, b) => b - a)[0];
        if (newest === undefined) throw new Error('empty references');
        await cache.setReference(String(newest));
      } catch {
        lastFailure.set(cache, Date.now()); // the age-based window covers a failed check
      }
    })().finally(() => checking.delete(cache));
    checking.set(cache, pending);
  }
  return pending;
}

/** Persistent layer: fresh hit, else network, else (on failure) an older answer rather than an error. */
export async function fetchPersistent<T>(url: string, token: string | undefined, cache: PersistentCache, referencesUrl: string): Promise<{ value: T; stale: boolean }> {
  await refreshReference(referencesUrl, token, cache);
  const hit = await cache.lookup(url);
  if (hit?.fresh) return { value: hit.value as T, stale: false };

  try {
    const value = await spend<T>(url, token, cache);
    void cache.store(url, value);
    return { value, stale: false };
  } catch (e) {
    if (hit) return { value: hit.value as T, stale: true };
    throw e;
  }
}

/** User-facing text for a failed lookup, or null for a plain network failure (each caller words that one). */
export function fipeErrorMessage(e: unknown): string | null {
  if (!(e instanceof FipeError)) return null;
  if (e.kind === 'rate-limit') return 'Limite da API FIPE excedido. Tente mais tarde ou informe um token no popup.';
  if (e.kind === 'auth') return 'Token da API FIPE inválido ou expirado. Corrija ou apague o token no popup.';
  return null;
}
