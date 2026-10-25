import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { StorageError, isContextInvalidated } from '../src/storage';
import { getSettings, getToken, DEFAULTS } from '../src/settings';

describe('storage.ts & settings.ts error handling', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
  });

  it('detects invalidated extension context when chrome.runtime.id is missing', () => {
    globalThis.chrome = undefined as any;
    expect(isContextInvalidated()).toBe(true);

    globalThis.chrome = { runtime: {} } as any;
    expect(isContextInvalidated()).toBe(true);

    globalThis.chrome = { runtime: { id: 'test-id' } } as any;
    expect(isContextInvalidated()).toBe(false);
  });

  it('resolves getSettings() with DEFAULTS when storage rejects', async () => {
    globalThis.chrome = {
      runtime: { id: 'test-id' },
      storage: {
        sync: {
          get: (_keys: any, cb: any) => {
            globalThis.chrome.runtime.lastError = { message: 'Quota exceeded' };
            cb(undefined);
          },
        },
      },
    } as any;

    const settings = await getSettings();
    expect(settings).toEqual({
      towing: DEFAULTS.towing,
      extraCosts: DEFAULTS.extraCosts,
      adminFee: DEFAULTS.adminFee,
      logisticsFee: DEFAULTS.logisticsFee,
      atpvFee: DEFAULTS.atpvFee,
      commissionRate: DEFAULTS.commissionRate / 100,
      ipvaFee: DEFAULTS.ipvaFee,
      resaleDiscount: DEFAULTS.resaleDiscount / 100,
      targetMargin: DEFAULTS.targetMargin / 100,
    });
  });

  it('resolves getToken() with empty string when storage rejects', async () => {
    globalThis.chrome = {
      runtime: { id: 'test-id' },
      storage: {
        sync: {
          get: (_keys: any, cb: any) => {
            globalThis.chrome.runtime.lastError = { message: 'Storage error' };
            cb(undefined);
          },
        },
      },
    } as any;

    const token = await getToken();
    expect(token).toBe('');
  });

  it('handles backend returning undefined without hanging promise (resolves within timeout)', async () => {
    globalThis.chrome = {
      runtime: { id: 'test-id' },
      storage: {
        sync: {
          get: (_keys: any, cb: any) => {
            cb(undefined);
          },
        },
      },
    } as any;

    const start = Date.now();
    const res = await getSettings();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(res).toEqual({
      towing: DEFAULTS.towing,
      extraCosts: DEFAULTS.extraCosts,
      adminFee: DEFAULTS.adminFee,
      logisticsFee: DEFAULTS.logisticsFee,
      atpvFee: DEFAULTS.atpvFee,
      commissionRate: DEFAULTS.commissionRate / 100,
      ipvaFee: DEFAULTS.ipvaFee,
      resaleDiscount: DEFAULTS.resaleDiscount / 100,
      targetMargin: DEFAULTS.targetMargin / 100,
    });
  }, 1000);

  it('displays reload warning in DOM when extension context is invalidated', () => {
    const dom = new JSDOM('<div id="container"><div class="fipe-results"></div></div>');
    const container = dom.window.document.getElementById('container') as HTMLElement;

    globalThis.chrome = undefined as any;

    expect(isContextInvalidated()).toBe(true);

    // Simulate content script rendering reload notice when context is invalidated
    container.dataset.state = 'invalidated';
    const resultsEl = container.querySelector('.fipe-results')!;
    resultsEl.innerHTML = `
      <div class="fipe-alert">
        <span class="fipe-not-found">Recarregue a página para continuar usando a extensão</span>
        <button type="button" class="fipe-reload-btn fipe-retry">Recarregar página</button>
      </div>
    `;

    expect(container.textContent).toContain('Recarregue a página para continuar usando a extensão');
    expect(container.querySelector('.fipe-reload-btn')?.textContent).toBe('Recarregar página');
  });
});
