import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, UPDATE_KEY, versionFromTag } from '../src/update_check';

describe('version helpers', () => {
  it('reads plain vX.Y.Z tags only', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('1.10.0')).toBe('1.10.0');
    expect(versionFromTag('v2026.11.10-abc')).toBeNull();
    expect(versionFromTag(undefined)).toBeNull();
  });

  it('compares numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
  });
});

describe('checkForUpdate', () => {
  const original = globalThis.chrome;
  let store: Record<string, unknown>;
  let calls: number;
  const release = (tag: string, extra: Record<string, unknown> = {}) => (async () => {
    calls++;
    return new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/juninmd/leilao-helper/releases/tag/${tag}`, ...extra }), { status: 200 });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    store = {};
    calls = 0;
    globalThis.chrome = {
      runtime: { id: 'x', getManifest: () => ({ version: '1.1.0' }) },
      storage: { local: {
        get: (keys: string[], cb: (v: unknown) => void) => cb(Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]]))),
        set: (items: Record<string, unknown>, cb: () => void) => { Object.assign(store, items); cb(); },
      } },
    } as unknown as typeof chrome;
  });
  afterEach(() => { globalThis.chrome = original; });

  it('flags a newer release and caches it for 12 h', async () => {
    const s = await checkForUpdate({ now: 1000, fetchImpl: release('v1.2.0') });
    expect(s).toMatchObject({ latest: '1.2.0', current: '1.1.0', available: true, url: 'https://github.com/juninmd/leilao-helper/releases/tag/v1.2.0' });
    await checkForUpdate({ now: 2000, fetchImpl: release('v9.9.9') });
    expect(calls).toBe(1);
    expect((store[UPDATE_KEY] as { latest: string }).latest).toBe('1.2.0');
    const forced = await checkForUpdate({ now: 3000, force: true, fetchImpl: release('v1.3.0') });
    expect(forced?.latest).toBe('1.3.0');
  });

  it('same or older release is not an update; a prerelease is ignored', async () => {
    expect((await checkForUpdate({ fetchImpl: release('v1.1.0') }))?.available).toBe(false);
    expect(await checkForUpdate({ force: true, fetchImpl: release('v2.0.0', { prerelease: true }) })).toMatchObject({ latest: '1.1.0' });
  });

  it('offline or 404 is "no news", never an error', async () => {
    const down = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await checkForUpdate({ fetchImpl: down })).toBeNull();
    const missing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    expect(await checkForUpdate({ fetchImpl: missing })).toBeNull();
  });
});
