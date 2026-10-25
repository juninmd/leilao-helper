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
    const rawResult = await new Promise<unknown>((resolve, reject) => {
      let resolved = false;

      try {
        const maybePromise: unknown = storageArea.get(keys as any, (cbResult?: unknown) => {
          if (resolved) return;
          resolved = true;
          const lastErr = globalThis.chrome?.runtime?.lastError;
          if (lastErr) {
            reject(new StorageError(typeof lastErr === 'string' ? lastErr : lastErr.message || 'Storage error'));
          } else if (cbResult === undefined) {
            reject(new StorageError('Storage returned undefined'));
          } else {
            resolve(cbResult);
          }
        });

        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
          (maybePromise as Promise<unknown>)
            .then((pResult) => {
              if (resolved) return;
              resolved = true;
              const lastErr = globalThis.chrome?.runtime?.lastError;
              if (lastErr) {
                reject(new StorageError(typeof lastErr === 'string' ? lastErr : lastErr.message || 'Storage error'));
              } else if (pResult === undefined) {
                reject(new StorageError('Storage returned undefined'));
              } else {
                resolve(pResult);
              }
            })
            .catch((err) => {
              if (resolved) return;
              resolved = true;
              reject(err instanceof StorageError ? err : new StorageError(err?.message || 'Storage error'));
            });
        }
      } catch (err: any) {
        if (!resolved) {
          resolved = true;
          reject(err instanceof StorageError ? err : new StorageError(err?.message || 'Storage error'));
        }
      }
    });

    return { ok: true, value: rawResult as T };
  } catch (err: any) {
    const errorName = err?.name || 'Error';
    console.warn(`[storageGet] ${errorName}`);
    return { ok: false, error: err instanceof StorageError ? err : new StorageError(err?.message || 'Storage error') };
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
    await new Promise<void>((resolve, reject) => {
      let resolved = false;

      try {
        const maybePromise: unknown = storageArea.set(items, () => {
          if (resolved) return;
          resolved = true;
          const lastErr = globalThis.chrome?.runtime?.lastError;
          if (lastErr) {
            reject(new StorageError(typeof lastErr === 'string' ? lastErr : lastErr.message || 'Storage error'));
          } else {
            resolve();
          }
        });

        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
          (maybePromise as Promise<unknown>)
            .then(() => {
              if (resolved) return;
              resolved = true;
              const lastErr = globalThis.chrome?.runtime?.lastError;
              if (lastErr) {
                reject(new StorageError(typeof lastErr === 'string' ? lastErr : lastErr.message || 'Storage error'));
              } else {
                resolve();
              }
            })
            .catch((err) => {
              if (resolved) return;
              resolved = true;
              reject(err instanceof StorageError ? err : new StorageError(err?.message || 'Storage error'));
            });
        }
      } catch (err: any) {
        if (!resolved) {
          resolved = true;
          reject(err instanceof StorageError ? err : new StorageError(err?.message || 'Storage error'));
        }
      }
    });

    return { ok: true };
  } catch (err: any) {
    const errorName = err?.name || 'Error';
    console.warn(`[storageSet] ${errorName}`);
    return { ok: false, error: err instanceof StorageError ? err : new StorageError(err?.message || 'Storage error') };
  }
}
