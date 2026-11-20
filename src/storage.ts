export class StorageError extends Error {
  constructor(message = 'Storage operation failed') {
    super(message);
    this.name = 'StorageError';
  }
}

export function isContextInvalidated(): boolean {
  try {
    return !globalThis.chrome?.runtime?.id;
  } catch {
    return true;
  }
}

export type StorageAreaName = 'sync' | 'local';

export interface StorageGetResult<T> {
  ok: boolean;
  value?: T;
  error?: StorageError;
}

export interface StorageSetResult {
  ok: boolean;
  error?: StorageError;
}

function toStorageError(err: any): StorageError {
  return err instanceof StorageError ? err : new StorageError(err?.message || 'Storage error');
}

/** Bridges chrome.storage's callback and promise styles: settles once, from whichever answers first. */
function callStorage<T>(call: (done: (result?: unknown) => void) => unknown, requireResult: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (result?: unknown) => {
      if (settled) return;
      settled = true;
      const lastErr = globalThis.chrome?.runtime?.lastError;
      if (lastErr) {
        reject(new StorageError(typeof lastErr === 'string' ? lastErr : lastErr.message || 'Storage error'));
      } else if (requireResult && result === undefined) {
        reject(new StorageError('Storage returned undefined'));
      } else {
        resolve(result as T);
      }
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(toStorageError(err));
    };
    try {
      const maybePromise = call(done);
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
        (maybePromise as Promise<unknown>).then(done).catch(fail);
      }
    } catch (err) {
      fail(err);
    }
  });
}

export async function storageGet<T = Record<string, unknown>>(
  area: StorageAreaName,
  keys: string | string[] | Record<string, unknown> | null
): Promise<StorageGetResult<T>> {
  if (isContextInvalidated()) {
    return { ok: false, error: new StorageError('Extension context invalidated') };
  }

  const storageArea = globalThis.chrome?.storage?.[area];
  if (!storageArea) {
    return { ok: false, error: new StorageError('Storage area unavailable') };
  }

  try {
    const value = await callStorage<T>(done => storageArea.get(keys as any, done), true);
    return { ok: true, value };
  } catch (err: any) {
    console.warn(`[storageGet] ${err?.name || 'Error'}`);
    return { ok: false, error: toStorageError(err) };
  }
}

export async function storageSet(
  area: StorageAreaName,
  items: Record<string, unknown>
): Promise<StorageSetResult> {
  if (isContextInvalidated()) {
    return { ok: false, error: new StorageError('Extension context invalidated') };
  }

  const storageArea = globalThis.chrome?.storage?.[area];
  if (!storageArea) {
    return { ok: false, error: new StorageError('Storage area unavailable') };
  }

  try {
    await callStorage<void>(done => storageArea.set(items, () => done()), false);
    return { ok: true };
  } catch (err: any) {
    console.warn(`[storageSet] ${err?.name || 'Error'}`);
    return { ok: false, error: toStorageError(err) };
  }
}
