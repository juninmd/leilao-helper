import { BrowserContext, chromium, Page, Route } from '@playwright/test';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

export const ROOT = resolve(__dirname, '..');
export const SHOTS = resolve(ROOT, 'docs/screenshots');
export const LIST_URL = 'https://www.freitasleiloeiro.com.br/Leiloes/Lotes?id=1';
export const DETAIL_URL = 'https://www.freitasleiloeiro.com.br/Leiloes/LoteDetalhes?id=1';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Chrome derives an unpacked extension id from the sha256 of its path (a-p alphabet); on Windows the path is hashed as UTF-16. */
export function extensionId(path: string): string {
  return createHash('sha256').update(process.platform === 'win32' ? Buffer.from(path, 'utf16le') : path).digest('hex').slice(0, 32).replace(/./g, c => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)));
}

export async function launch(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/astral-`), {
    executablePath: CHROME,
    headless: false,
    viewport: { width: 1100, height: 900 },
    args: ['--headless=new', '--no-sandbox', ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--ignore-certificate-errors'] : []), `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
}

export interface Lot { desc: string; bid: number; fees?: string }

const defaultFees = `
  <li>5% referente à comissão do leiloeiro</li>
  <li>Despesas administrativas de Organização e Depósito no valor de R$ 1.900,00</li>
  <li>Despesas de logística no valor de R$ 1.416,00</li>`;

const money = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

function card(l: Lot, i: number) {
  return `
  <div class="col-md-4"><div class="card cardLote" data-testid="lot-${i}">
    <img alt="" width="40" height="30" />
    <div class="cardLote-descVeic">${l.desc}</div>
    <div class="cardLote-lance"><small>Maior lance</small>
      <div class="cardLote-vlr" id="vlr-${i}">${money(l.bid)}</div>
      <input type="hidden" id="hdMaiorLance" value="${l.bid}" />
    </div>
    <ul class="small text-secondary">${l.fees ?? defaultFees}</ul>
  </div></div>`;
}

export const listPage = (lots: Lot[]) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Lotes</title>
<style>body{font-family:sans-serif;background:#f4f4f4}.row{display:flex;flex-wrap:wrap;gap:12px}.col-md-4{width:340px}.card{background:#fff;padding:12px;border-radius:6px}</style></head>
<body><h1>Freitas Leiloeiro — Lotes (fixture)</h1><div class="row" id="lots">${lots.map(card).join('')}</div></body></html>`;

export const detailPage = (l: Lot) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Lote</title>
<style>body{font-family:sans-serif;background:#f4f4f4}.col-md-8{width:600px}.card{background:#fff;padding:12px;border-radius:6px}</style></head>
<body><main><div class="col-md-8"><div class="card">
  <h2>Detalhes do lote (fixture)</h2>
  <div style="text-align:justify">${l.desc}</div>
  <div class="lance">Maior lance: <span>${money(l.bid)}</span></div>
  <input type="hidden" id="hdMaiorLance" value="${l.bid}" />
  <ul class="small text-secondary">${l.fees ?? defaultFees}</ul>
</div></div></main></body></html>`;

/** Detail page of a lot nobody bid on yet, shaped like the live site (initial bid box + empty "Maior lance"). */
export const detailPageNoBids = (l: Lot) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Lote</title>
<style>body{font-family:sans-serif;background:#f4f4f4}.col-md-8{width:600px}.card{background:#fff;padding:12px;border-radius:6px;margin-bottom:8px}.row{display:flex}.col-6{width:50%}</style></head>
<body><main><div class="col-md-8"><div class="card">
  <h2>Detalhes do lote (fixture)</h2>
  <div style="text-align:justify">${l.desc}</div>
  <ul class="small text-secondary">${l.fees ?? defaultFees}</ul>
</div>
<div class="card"><div class="row">
  <div class="col-6 text-center"><div class="fw-bold text-warning">${money(l.bid)}</div><small>Lance Inicial</small></div>
  <div class="col-6 text-center"><div class="fw-bold text-warning">R$ 500,00</div><small>Incremento Mínimo</small></div>
</div></div>
<div class="card"><div class="card-body small"><div>Maior lance:</div>
  <div id="dvMaiorLance"><input type="hidden" id="hdMaiorLance" value="0" />Aguardando lances</div></div></div>
</div></main></body></html>`;

// ---- FIPE API mock (shapes copied from the real BrasilAPI / FIPE v2 responses) ----
export interface ApiMode { price429?: boolean; offline?: boolean; calls: string[]; /** Latest GitHub release tag; defaults to the manifest's own version (no update). */ latestRelease?: string }

const brands = [{ nome: 'Fiat', valor: '21' }, { nome: 'VW - VolksWagen', valor: '59' }, { nome: 'GM - Chevrolet', valor: '23' }];
const models: Record<string, { modelo: string; valor: string }[]> = {
  '21': [{ modelo: 'Uno Mille Economy 1.0 Fire Flex 8V 4p', valor: '100' }, { modelo: 'Uno Way 1.4 Evo Flex 8V 4p', valor: '103' }, { modelo: 'Palio Fire 1.0', valor: '102' }],
  '59': [{ modelo: 'Gol City 1.0 Flex 8V 4p', valor: '200' }],
  '23': Array.from({ length: 120 }, (_, i) => ({ modelo: `Onix Série ${i + 1}`, valor: String(300 + i) })), // more than the dropdown cap
};
const motoBrands = [{ nome: 'HONDA', valor: '80' }];
const motoModels = [{ modelo: 'CG 160 Fan', valor: '900' }];
export const FIPE_PRICES: Record<string, number> = { '100': 20000, '103': 25000, '200': 40000, '900': 12000 };
const modelName = (id: string) => [...models['21'], ...models['59'], ...motoModels].find(m => m.valor === id)?.modelo ?? `Modelo ${id}`;

export async function mockApis(context: BrowserContext, mode: ApiMode) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

  // Update check (popup + background): never hit the real GitHub API from tests.
  await context.route(/api\.github\.com\/repos\/juninmd\/leilao-helper\/releases\/latest/, route => {
    const tag = mode.latestRelease ?? `v${JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8')).version}`;
    return json(route, { tag_name: tag, html_url: `https://github.com/juninmd/leilao-helper/releases/tag/${tag}`, draft: false, prerelease: false });
  });

  await context.route(/brasilapi\.com\.br|fipe\.parallelum\.com\.br/, async route => {
    const url = route.request().url();
    mode.calls.push(url);
    if (mode.offline) return route.abort('failed');
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (url.endsWith('/references')) return json(route, [{ code: '338', month: 'outubro/2026' }, { code: '337', month: 'setembro/2026' }]);
    if (url.endsWith('/marcas/v1/carros')) return json(route, brands);
    if (url.endsWith('/marcas/v1/motos')) return json(route, motoBrands);
    if (url.endsWith('/marcas/v1/caminhoes')) return json(route, []);
    if (/veiculos\/v1\/motos\/80$/.test(url)) return json(route, motoModels);
    let m = url.match(/veiculos\/v1\/carros\/(\d+)$/);
    if (m) return json(route, models[m[1]] ?? []);
    if (/\/years/.test(url) && mode.price429) return json(route, { error: 'limite de taxa excedido' }, 429);
    m = url.match(/models\/(\d+)\/years$/);
    if (m) return json(route, [{ code: '2009-1', name: '2009 Gasolina' }, { code: '2013-1', name: '2013 Gasolina' }]);
    m = url.match(/models\/(\d+)\/years\/(\d+)-1$/);
    if (m) return json(route, { vehicleType: 1, price: money(FIPE_PRICES[m[1]] ?? 10000), brand: 'X', model: modelName(m[1]), modelYear: Number(m[2]), fuel: 'Gasolina', codeFipe: '001124-0', referenceMonth: 'outubro de 2026', fuelAcronym: 'G' });
    return json(route, {}, 404);
  });
}

export async function serve(context: BrowserContext, pages: Record<string, () => string>) {
  await context.route(/freitasleiloeiro\.com\.br/, route => {
    const url = new URL(route.request().url());
    const key = url.pathname + url.search;
    const html = pages[key] ?? pages[url.pathname];
    if (!html) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html() });
  });
}

export const popupUrl = () => `chrome-extension://${extensionId(ROOT)}/dist/popup.html`;
export const lotCard = (page: Page, i: number) => page.locator(`[data-testid="lot-${i}"] .fipe-helper-container`);
