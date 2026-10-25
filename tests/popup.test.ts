import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

describe('popup.ts error state in jsdom', () => {
  const originalChrome = globalThis.chrome;
  let dom: JSDOM;

  beforeEach(() => {
    vi.restoreAllMocks();
    const html = fs.readFileSync(path.resolve(__dirname, '../src/popup.html'), 'utf8');
    dom = new JSDOM(html, { runScripts: 'outside-only' });
    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
  });

  it('shows red alert message and hides success message when save fails', async () => {
    globalThis.chrome = {
      runtime: { id: 'test-id' },
      storage: {
        sync: {
          get: (_keys: any, cb: any) => {
            cb({});
          },
          set: (_items: any, cb: any) => {
            globalThis.chrome.runtime.lastError = { message: 'Quota exceeded' };
            cb();
          },
        },
        local: {
          get: (_keys: any, cb: any) => cb({}),
        },
      },
    } as any;

    // Load popup script dynamically
    await import('../src/popup');

    const form = dom.window.document.getElementById('config-form') as HTMLFormElement;
    const successMsg = dom.window.document.getElementById('success') as HTMLDivElement;
    const errorMsg = dom.window.document.getElementById('error') as HTMLDivElement;

    // Submit form
    const event = new dom.window.Event('submit', { cancelable: true, bubbles: true });
    form.dispatchEvent(event);

    // Wait for promise microtasks
    await new Promise((r) => setTimeout(r, 50));

    expect(errorMsg.style.display).toBe('block');
    expect(errorMsg.getAttribute('role')).toBe('alert');
    expect(errorMsg.textContent).toContain('Não foi possível salvar. Tente novamente.');
    expect(successMsg.style.display).toBe('none');
  });
});
