import { FipeError, FipeService } from './fipe_service';
import { CalculationResult } from './types';
import { bidRange, calculate, CURRENCY_PATTERN, dealScore, extractCurrency, Fees, PageFees, parseBidInput, parseCurrency, parseDescription } from './lib';
import { getAutoLookupEnabled, getSettings, getToken, setStored, AUTO_LOOKUP_KEY } from './settings';
import { isContextInvalidated, StorageSetResult } from './storage';
import { categoryOf, Selection, showVehiclePicker } from './vehicle_picker';
import { LotStore } from './lot_store';
import { LotNotes, mountLotNotes } from './lot_notes';
import { detectRisks, Risk } from './risks';
import { LOGO, RadarEntry, updateRadar } from './radar';

const VEHICLE_DESCRIPTION_PATTERN = /(?:[^/\s,]+\/)?[^/,]+\/[^,]+,\s*\d{2}\/\d{2}/i;
const DETAIL_PANEL_ID = 'fipe-detail-helper';
const COLOR_GOOD = '#43e5a0';
const COLOR_BAD = '#ff8a65';
const COMMISSION_PATTERN = /(\d+(?:[.,]\d+)?)\s*%\s*(?:referente à comissão|comissão do leiloeiro)/i;
// The site words this fee "administrativas" on some auctions and "operacionais" on others.
const ADMIN_FEE_PATTERN = /Despesas (?:administrativas|operacionais)[^,]*?no valor de\s*(R\$\s*[\d.]+,\d{2})/i;
const LOGISTICS_FEE_PATTERN = /Despesas de logística[^,]*?no valor de\s*(R\$\s*[\d.]+,\d{2})/i;

let ipvaTimer: number | null = null;
function setIpvaFee(value: number): Promise<StorageSetResult> {
  if (ipvaTimer !== null) window.clearTimeout(ipvaTimer);
  return new Promise((resolve) => {
    ipvaTimer = window.setTimeout(() => {
      ipvaTimer = null;
      void setStored({ ipvaFee: value }).then(resolve);
    }, 500);
  });
}

const IPVA_PAID_PATTERN = /IPVA\s*\d{0,4}\s*PAGO/i;

function extractFeesFromPage(root: ParentNode = document): PageFees {
  const result: PageFees = {};

  const bodyText = (root instanceof Document ? root.body : (root as Element))?.textContent || '';
  if (IPVA_PAID_PATTERN.test(bodyText)) {
    result.ipvaPaid = true;
  }

  const lists = root.querySelectorAll('ul.small.text-secondary');
  for (let i = 0; i < lists.length; i++) {
    const text = lists[i].textContent || '';

    if (IPVA_PAID_PATTERN.test(text)) {
      result.ipvaPaid = true;
    }

    const commissionMatch = text.match(COMMISSION_PATTERN);
    if (commissionMatch) {
      const rate = parseFloat(commissionMatch[1].replace(',', '.')) / 100;
      if (!Number.isNaN(rate)) {
        result.commissionRate = rate;
      }
    }

    const adminMatch = text.match(ADMIN_FEE_PATTERN);
    if (adminMatch) {
      result.adminFee = parseCurrency(adminMatch[1]);
    }

    const logisticsMatch = text.match(LOGISTICS_FEE_PATTERN);
    if (logisticsMatch) {
      result.logisticsFee = parseCurrency(logisticsMatch[1]);
    }
  }

  return result;
}

function getTextContent(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function isVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  return Boolean(htmlElement.offsetWidth || htmlElement.offsetHeight || htmlElement.getClientRects().length);
}

const OWN_UI = '.fipe-helper-container, .fipe-modal-overlay, .fipe-radar';

/** Page text only: our own panel must never be read back as lot data (it holds the very numbers we compute). */
function pageText(element: Element): string {
  if (!element.querySelector(OWN_UI)) return getTextContent(element);
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(OWN_UI).forEach(node => node.remove());
  return getTextContent(clone);
}

/** The lot's visible text as one block per text node, without our own panel, for the red-flag scan. */
function textBlocks(scope: Element): string[] {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest(`${OWN_UI}, script, style, noscript`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const blocks: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.replace(/\s+/g, ' ').trim();
    if (text) blocks.push(text);
  }
  return blocks;
}

function findElementsByText(root: ParentNode, pattern: RegExp): HTMLElement[] {
  const matches: HTMLElement[] = [];

  if (root instanceof Element) {
    const rootText = pageText(root);
    if (rootText && pattern.test(rootText)) {
      matches.push(root as HTMLElement);
    }
  }

  const elements = root.querySelectorAll('div, span, p, h1, h2, h3, h4, td, li, small, strong, a');
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (element.closest(OWN_UI) || !isVisible(element)) continue;
    const text = pageText(element);
    if (!text || text.length > 600) continue;
    if (pattern.test(text)) {
      matches.push(element as HTMLElement);
    }
  }

  return matches;
}

const DESCRIPTION_SELECTORS = [
  '.cardLote-descVeic',
  '[class*="descVeic"]',
  '[class*="Descricao"]',
  '[class*="descricao"]',
  'div[style*="text-align:justify"]',
];

/** Number of distinct vehicle descriptions inside a node (including the node itself). */
function countDescriptions(root: HTMLElement): number {
  const found = new Set<Element>();
  const candidates = [...(root.matches(DESCRIPTION_SELECTORS.join(',')) ? [root] : []), ...root.querySelectorAll(DESCRIPTION_SELECTORS.join(','))];
  for (const el of candidates) {
    if (VEHICLE_DESCRIPTION_PATTERN.test(getTextContent(el))) found.add(el);
  }
  return found.size;
}

function findDescriptionElement(root: ParentNode): HTMLElement | null {
  for (const selector of DESCRIPTION_SELECTORS) {
    const elements = root.querySelectorAll(selector);
    for (let index = 0; index < elements.length; index += 1) {
      const text = getTextContent(elements[index]);
      if (VEHICLE_DESCRIPTION_PATTERN.test(text)) {
        return elements[index] as HTMLElement;
      }
    }
  }

  const textMatches = findElementsByText(root, VEHICLE_DESCRIPTION_PATTERN);
  return textMatches.find(element => getTextContent(element).length < 250) || null;
}

function findBidText(root: ParentNode): string {
  for (const selector of ['#hdMaiorLance', '#dvMaiorLance', '[id*="MaiorLance"]', '[class*="MaiorLance"]']) {
    const elements = root.querySelectorAll(selector);
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (selector !== '#hdMaiorLance' && !isVisible(element)) continue;

      const inputValue = (element as HTMLInputElement).value;
      if (inputValue) {
        const value = parseBidInput(inputValue);
        if (value > 0) {
          return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
      }

      const text = getTextContent(element);
      const currency = extractCurrency(text);
      if (currency) return currency;
    }
  }

  const candidates = findElementsByText(root, CURRENCY_PATTERN)
    .map(element => pageText(element))
    .filter(text => !/incremento/i.test(text));

  const currentBid = candidates.find(text => /maior lance|lance atual/i.test(text));
  if (currentBid) return extractCurrency(currentBid) || '0';

  const initialBid = candidates.find(text => /lance inicial/i.test(text));
  if (initialBid) return extractCurrency(initialBid) || '0';

  return extractCurrency(candidates[0] || '') || '0';
}

function ensureContainer(host: HTMLElement, insertionTarget: HTMLElement, id?: string): HTMLElement {
  let container = id
    ? host.querySelector<HTMLElement>(`#${id}`)
    : host.querySelector<HTMLElement>('.fipe-helper-container[data-role="lot"]');

  if (!container) {
    container = document.createElement('div');
    container.className = 'fipe-helper-container';
    container.dataset.role = 'lot';
    if (id) container.id = id;
    insertionTarget.appendChild(container);
  }

  // Ensure structure supports the new manual/auto UI.
  let controls = container.querySelector<HTMLElement>('.fipe-controls');
  if (!controls) {
    controls = document.createElement('div');
    controls.className = 'fipe-controls';
    container.prepend(controls);
  }

  let results = container.querySelector<HTMLElement>('.fipe-results');
  if (!results) {
    results = document.createElement('div');
    results.className = 'fipe-results';
    container.appendChild(results);
  }

  return container;
}

function getResultsContainer(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.fipe-results') ?? container;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

interface LotContext {
  root: ParentNode;
  /** The element holding just this lot's text (a card, or the detail column), scanned for red flags. */
  scope: Element;
  description: string;
  bidText: string;
}

const contexts = new WeakMap<HTMLElement, LotContext>();
const notes = new WeakMap<HTMLElement, LotNotes>();
// Vehicle picked manually for a lot; survives re-renders until the lot's description changes.
const overrides = new WeakMap<HTMLElement, Selection>();
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

interface FipeInfo { value: number; model: string; reference: string; approximate?: boolean }
/** What the last render was computed from, so the bid simulator can recompute without touching the page. */
interface View { fipe: FipeInfo | null; risks: Risk[]; settings: Fees; pageFees: PageFees; bid: number }
const views = new WeakMap<HTMLElement, View>();

const RING = 2 * Math.PI * 42;
const svg = (body: string, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  notFound: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8.5 8.5l5 5M13.5 8.5l-5 5"/>', 22),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 22),
  offline: svg('<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01M3 3l18 18"/>', 22),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  alert: svg('<path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 18h.01"/>', 12),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>', 12),
  chevron: svg('<path d="m6 9 6 6 6-6"/>', 14),
};

function row(label: string, value: string, extra = ''): string {
  return `<div class="fipe-row"${extra}><span class="fipe-label">${label}</span><span class="fipe-value">${value}</span></div>`;
}

function stat(label: string, value: string, key = ''): string {
  return `<div class="fipe-stat"><span class="fipe-label">${label}</span><span class="fipe-value"${key ? ` data-k="${key}"` : ''}>${value}</span></div>`;
}

const percent = (fraction: number) => Number((fraction * 100).toFixed(2)).toLocaleString('pt-BR');
const reduceMotion = () => document.hidden || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

function risksBlock(risks: Risk[]): string {
  if (risks.length === 0) return '';
  const chips = risks.map((r, i) => `<li class="fipe-risk ${r.level}" style="--i:${i}">${r.level === 'high' ? ICON.alert : ICON.info}${escapeHtml(r.label)}</li>`).join('');
  return `<div class="fipe-risks-wrap"><ul class="fipe-risks" aria-label="Alertas do lote">${chips}</ul><span class="fipe-maxbid-note">Palavras de risco no texto do lote. Confira no edital.</span></div>`;
}

function maxBidInner(r: CalculationResult, simulating: boolean): string {
  const goal = r.targetMargin > 0 ? `lucro de ${percent(r.targetMargin)}%` : 'sem prejuízo';
  const title = `<span class="fipe-label">Lance máximo (${goal})</span>`;
  if (r.maxBid <= 0) return `${title}<span class="fipe-value">Inviável</span><span class="fipe-maxbid-note">Os custos fixos superam a FIPE</span>`;
  const gap = r.maxBid - r.bidValue;
  const which = simulating ? 'lance simulado' : 'lance atual';
  const note = gap >= 0 ? `Folga de ${brl.format(gap)} sobre o ${which}` : `${simulating ? 'Lance simulado' : 'Lance atual'} excede em ${brl.format(-gap)}`;
  return `${title}<span class="fipe-value">${brl.format(r.maxBid)}</span><span class="fipe-maxbid-note">${note}</span>`;
}

function breakdownHtml(r: CalculationResult): string {
  const discounted = r.fipeValue > 0 && r.resaleValue !== r.fipeValue;
  return `<div class="fipe-rows">${[
    discounted ? row(`Revenda estimada (FIPE −${percent(1 - r.resaleValue / r.fipeValue)}%):`, brl.format(r.resaleValue)) : '',
    row('Lance (Maior/Inicial):', brl.format(r.bidValue)),
    row(`Comissão Leiloeiro (${percent(r.commissionRate)}%):`, brl.format(r.commission)),
    row('Despesas Adm/Org/Dep:', brl.format(r.adminFee)),
    row('Despesas Logística:', brl.format(r.logisticsFee)),
    row('Custos Extras:', brl.format(r.extraCosts)),
    row('ATPV-e:', brl.format(r.atpvFee)),
    row('Guincho (Est.):', brl.format(r.towing)),
    r.ipvaFee > 0 ? row('IPVA (não pago):', brl.format(r.ipvaFee)) : '',
  ].join('')}${row('Custo total', brl.format(r.totalCost), ' data-total')}</div>
  ${r.ipvaFee > 0 ? '<p class="fipe-maxbid-note">IPVA somado por você. Confira no edital se é do comprador: a regra de débitos muda de leilão para leilão.</p>' : ''}`;
}

/** Profit counts up from zero on the first paint; the final text is always set, even if frames never run. */
function countUp(el: HTMLElement, to: number, animate: boolean) {
  const token = String(to);
  el.dataset.v = token;
  const final = brl.format(to);
  if (!animate || reduceMotion()) { el.textContent = final; return; }
  const start = performance.now();
  const duration = 450;
  el.textContent = brl.format(0);
  const tick = (now: number) => {
    if (el.dataset.v !== token) return;
    const t = Math.min(1, (now - start) / duration);
    el.textContent = t >= 1 ? final : brl.format(to * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.setTimeout(() => { if (el.dataset.v === token) el.textContent = final; }, duration + 60);
}

function setCosts(container: HTMLElement, html: string) {
  const details = container.querySelector<HTMLElement>('.fipe-details');
  if (!details) return;
  if (details.innerHTML !== html) details.innerHTML = html;
  container.dataset.hasCosts = html ? 'true' : 'false';
  applyTabs(container);
}

function applyTabs(container: HTMLElement) {
  const open = container.dataset.tab ?? '';
  container.querySelectorAll<HTMLButtonElement>('.fipe-tab').forEach(tab => {
    const key = tab.dataset.tab!;
    const available = key !== 'costs' || container.dataset.hasCosts === 'true';
    tab.hidden = !available;
    const expanded = available && open === key;
    if (tab.getAttribute('aria-expanded') !== String(expanded)) tab.setAttribute('aria-expanded', String(expanded));
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    if (panel && panel.hidden === expanded) panel.hidden = !expanded;
  });
  const bar = container.querySelector<HTMLElement>('.fipe-tabs');
  if (bar) bar.hidden = [...bar.querySelectorAll<HTMLElement>('.fipe-tab')].every(t => t.hidden);
}

/** Writes every number that depends on the bid. Used for the first paint and on each move of the simulator. */
function paint(container: HTMLElement, view: View, bid: number, animate: boolean): CalculationResult {
  const r = calculate(view.fipe?.value ?? 0, bid, view.settings, view.pageFees);
  const res = getResultsContainer(container);
  const k = (key: string) => res.querySelector<HTMLElement>(`[data-k="${key}"]`);
  const simulating = bid !== view.bid;
  setCosts(container, breakdownHtml(r));
  const cost = k('cost');
  if (cost) cost.textContent = brl.format(r.totalCost);
  if (!view.fipe) return r;

  const s = dealScore(r, view.risks);
  const good = r.profit > 0;
  container.style.borderLeftColor = good ? COLOR_GOOD : COLOR_BAD;
  res.querySelector('.fipe-hero')?.classList.toggle('negative', !good);
  res.querySelector('.fipe-profit')?.classList.toggle('negative', !good);
  const profit = k('profit');
  if (profit) countUp(profit, r.profit, animate);
  const pct = k('pct');
  if (pct) { pct.textContent = `${good ? '▲' : '▼'} ${r.profitPercentage.toFixed(1).replace('.', ',')}%`; pct.classList.toggle('negative', !good); }
  const verdict = k('verdict');
  if (verdict) verdict.textContent = s.verdict;
  const score = res.querySelector<HTMLElement>('.fipe-score');
  if (score) {
    score.dataset.tone = s.tone;
    score.setAttribute('aria-label', `Nota do negócio ${s.score} de 100: ${s.verdict}`);
    score.querySelector<SVGElement>('.fipe-ring')?.style.setProperty('stroke-dashoffset', (RING * (1 - s.score / 100)).toFixed(1));
    const num = k('score');
    if (num) num.textContent = String(s.score);
  }

  const total = Math.max(r.resaleValue, r.totalCost) || 1;
  const width = (v: number) => `${Math.max(0, (v / total) * 100).toFixed(2)}%`;
  const seg = (name: string, v: number) => res.querySelector<HTMLElement>(`[data-seg="${name}"]`)?.style.setProperty('width', width(v));
  seg('bid', r.bidValue);
  seg('com', r.commission);
  seg('fix', r.totalCost - r.bidValue - r.commission);
  seg('profit', Math.max(0, r.profit));
  const mark = res.querySelector<HTMLElement>('.fipe-flow-mark');
  if (mark) { mark.hidden = good; mark.style.left = width(r.resaleValue); }
  const legend = k('flow-profit');
  if (legend) legend.textContent = good ? `Lucro ${brl.format(r.profit)}` : `Prejuízo ${brl.format(-r.profit)}`;

  const bidOut = k('bid');
  if (bidOut) bidOut.textContent = brl.format(bid);
  res.querySelector<HTMLElement>('.fipe-sim')?.classList.toggle('active', simulating);
  const reset = res.querySelector<HTMLButtonElement>('.fipe-sim-reset');
  if (reset) reset.hidden = !simulating;
  const maxBox = res.querySelector<HTMLElement>('.fipe-maxbid');
  if (maxBox) {
    maxBox.innerHTML = maxBidInner(r, simulating);
    maxBox.classList.toggle('negative', r.maxBid <= 0 || r.maxBid < r.bidValue);
  }
  return r;
}

function simulatorHtml(r: CalculationResult): string {
  const range = bidRange(r.bidValue, r.maxBid);
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - range.min) / (range.max - range.min)) * 100)).toFixed(2)}%`;
  return `
    <div class="fipe-sim">
      <div class="fipe-sim-head">
        <span class="fipe-label">Simulador de lance</span>
        <button type="button" class="fipe-sim-reset" hidden>↺ Voltar ao atual</button>
      </div>
      <output class="fipe-sim-bid" data-k="bid">${brl.format(r.bidValue)}</output>
      <div class="fipe-sim-track" style="--ok:${r.maxBid > 0 ? at(r.maxBid) : '0%'};--cur:${at(r.bidValue)}">
        <i class="fipe-sim-zone" aria-hidden="true"></i><i class="fipe-sim-curmark" aria-hidden="true"></i>${r.maxBid > 0 ? '<i class="fipe-sim-maxmark" aria-hidden="true"></i>' : ''}
        <input type="range" class="fipe-sim-range" min="${range.min}" max="${range.max}" step="${range.step}" value="${r.bidValue}" aria-label="Simular valor do lance" aria-valuetext="${brl.format(r.bidValue)}" />
      </div>
      <div class="fipe-sim-scale"><span>${brl.format(range.min)}</span>${r.maxBid > 0 ? `<span class="fipe-sim-maxlabel">▲ máx. ${brl.format(r.maxBid)}</span>` : ''}<span>${brl.format(range.max)}</span></div>
    </div>`;
}

function updateResults(container: HTMLElement, view: View) {
  const resultsEl = getResultsContainer(container);
  views.set(container, view);
  const { fipe, risks } = view;
  const first = calculate(fipe?.value ?? 0, view.bid, view.settings, view.pageFees);

  if (!fipe) {
    container.style.borderLeftColor = '';
    resultsEl.innerHTML = `${risksBlock(risks)}<div class="fipe-stats">${stat('Lance', brl.format(first.bidValue))}${stat('Custo Total', brl.format(first.totalCost), 'cost')}</div>`;
    paint(container, view, view.bid, false);
    return;
  }

  const discounted = first.resaleValue !== first.fipeValue;
  resultsEl.innerHTML = `
    <p class="fipe-model-line"><span class="fipe-fipe-model">${escapeHtml(fipe.model)} · ${escapeHtml(fipe.reference)}${fipe.approximate ? ' · <span class="fipe-approx" title="A versão exata não foi identificada. Confira em Selecionar veículo.">aproximado</span>' : ''}</span></p>
    <div class="fipe-hero">
      <div class="fipe-score" role="img">
        <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="fipe-ring-bg" cx="50" cy="50" r="42"/><circle class="fipe-ring" cx="50" cy="50" r="42" stroke-dasharray="${RING.toFixed(1)}"/></svg>
        <span class="fipe-score-num" data-k="score" aria-hidden="true"></span><span class="fipe-score-cap" aria-hidden="true">nota</span>
      </div>
      <div class="fipe-hero-main">
        <span class="fipe-label">Lucro Estimado</span>
        <div class="fipe-profit"><span class="fipe-value" data-k="profit"></span></div>
        <div class="fipe-hero-tags"><span class="fipe-badge" data-k="pct"></span><span class="fipe-verdict" data-k="verdict"></span></div>
      </div>
    </div>
    ${risksBlock(risks)}
    <div class="fipe-stats">
      ${stat('Valor FIPE', brl.format(fipe.value))}
      ${discounted ? stat(`Revenda (−${percent(1 - first.resaleValue / first.fipeValue)}%)`, brl.format(first.resaleValue)) : ''}
      ${stat('Custo Total', brl.format(first.totalCost), 'cost')}
    </div>
    <div class="fipe-flow">
      <div class="fipe-flow-head"><span>Para onde vai a revenda</span><span>${brl.format(first.resaleValue)}</span></div>
      <div class="fipe-flow-bar" aria-hidden="true"><i data-seg="bid"></i><i data-seg="com"></i><i data-seg="fix"></i><i data-seg="profit"></i><b class="fipe-flow-mark" hidden></b></div>
      <div class="fipe-flow-legend"><span class="bid">Lance</span><span class="com">Comissão</span><span class="fix">Taxas fixas</span><span class="profit" data-k="flow-profit"></span></div>
    </div>
    ${simulatorHtml(first)}
    <div class="fipe-maxbid"></div>`;
  paint(container, view, view.bid, true);

  const range = resultsEl.querySelector<HTMLInputElement>('.fipe-sim-range');
  range?.addEventListener('input', () => {
    const bid = Number(range.value);
    range.setAttribute('aria-valuetext', brl.format(bid));
    paint(container, view, bid, false);
  });
  resultsEl.querySelector<HTMLButtonElement>('.fipe-sim-reset')?.addEventListener('click', () => {
    if (range) { range.value = String(view.bid); range.setAttribute('aria-valuetext', brl.format(view.bid)); }
    paint(container, view, view.bid, false);
    range?.focus();
  });
}

function alertHtml(icon: string, title: string, body = '', actions = '', tone = 'warn'): string {
  return `<div class="fipe-alert ${tone}" role="status">${icon}<div class="fipe-alert-text"><span class="fipe-not-found">${escapeHtml(title)}</span>${body ? `<span class="fipe-alert-sub">${escapeHtml(body)}</span>` : ''}</div>${actions ? `<div class="fipe-alert-actions">${actions}</div>` : ''}</div>`;
}

function showMessage(container: HTMLElement, message: string) {
  getResultsContainer(container).innerHTML = alertHtml(ICON.notFound, message);
  setCosts(container, '');
}

function showInvalidatedNotice(container: HTMLElement) {
  container.dataset.state = 'invalidated';
  container.style.borderLeftColor = '';
  setCosts(container, '');
  getResultsContainer(container).innerHTML = alertHtml(LOGO, 'Recarregue a página para continuar usando a extensão', 'Uma nova versão foi instalada.',
    '<button type="button" class="fipe-reload-btn fipe-retry fipe-btn-primary">Recarregar página</button>', 'info');
  container.querySelector<HTMLButtonElement>('.fipe-reload-btn')?.addEventListener('click', () => {
    window.location.reload();
  });
}

function showLoading(container: HTMLElement) {
  setCosts(container, '');
  getResultsContainer(container).innerHTML = `
    <div class="fipe-loading" role="status">
      <div class="fipe-loading-head"><span class="fipe-spinner" aria-hidden="true"><i></i></span><span class="fipe-label">Consultando FIPE...</span></div>
      <div class="fipe-skeleton" aria-hidden="true"><i class="tall"></i><i></i><i class="short"></i></div>
    </div>`;
}

function reportRadar(container: HTMLElement, ctx: LotContext, data: { profit: number | null; score: number | null; risks: Risk[] } | null) {
  if (container.id) return; // the detail page has one lot: nothing to compare
  if (data) {
    const parsed = parseDescription(ctx.description);
    radarEntries.set(container, { container, card: ctx.scope as HTMLElement, title: parsed ? `${parsed.brand} ${parsed.model}` : ctx.description, profit: data.profit, score: data.score, high: data.risks.filter(r => r.level === 'high').length });
  } else radarEntries.delete(container);
  scheduleRadar();
}

const radarEntries = new Map<HTMLElement, RadarEntry>();
let radarTimer: number | null = null;
function scheduleRadar() {
  if (radarTimer !== null) window.clearTimeout(radarTimer);
  radarTimer = window.setTimeout(() => {
    radarTimer = null;
    for (const c of [...radarEntries.keys()]) if (!c.isConnected) radarEntries.delete(c);
    updateRadar([...radarEntries.values()]);
  }, 120);
}

async function renderEvaluation(container: HTMLElement, ctx: LotContext, override?: Selection) {
  if (isContextInvalidated()) {
    showInvalidatedNotice(container);
    return;
  }

  const picked = override ?? overrides.get(container);
  const parsed = picked ? null : parseDescription(ctx.description);
  container.style.borderLeftColor = '';

  if (!picked && !parsed) {
    container.dataset.state = 'error';
    showMessage(container, 'Não foi possível interpretar o veículo');
    reportRadar(container, ctx, null);
    return;
  }

  const run = String(Number(container.dataset.run ?? '0') + 1);
  container.dataset.run = run;
  container.dataset.state = 'loading';
  showLoading(container);

  const bidValue = parseCurrency(ctx.bidText);
  const [settings, token] = await Promise.all([getSettings(), getToken()]);
  const pageFees = extractFeesFromPage(ctx.root);
  const risks = detectRisks(textBlocks(ctx.scope));
  const base: View = { fipe: null, risks, settings, pageFees, bid: bidValue };
  notes.get(container)?.setMaxBid(null);

  const pick = `<button type="button" class="fipe-alert-pick fipe-btn-primary">${ICON.search}Selecionar veículo</button>`;
  const bindPick = () => container.querySelector<HTMLButtonElement>('.fipe-alert-pick')?.addEventListener('click', () => openManual(container));

  try {
    const fipeData = picked
      ? await FipeService.getPriceByCode(categoryOf(picked.categoryKey), picked.brandCode, picked.modelCode, picked.yearCode, token || undefined)
      : await FipeService.getPrice(parsed!.brand, parsed!.model, parsed!.modelYear, token || undefined);
    if (container.dataset.run !== run) return; // superseded by a newer render

    if (!fipeData) {
      container.dataset.state = 'notfound';
      updateResults(container, base);
      getResultsContainer(container).insertAdjacentHTML('afterbegin',
        alertHtml(ICON.notFound, `FIPE não encontrada para ${parsed!.brand} ${parsed!.model} (${parsed!.modelYear})`, 'Escolha o veículo uma vez; a escolha fica guardada para este lote.', pick));
      bindPick();
      reportRadar(container, ctx, { profit: null, score: null, risks });
      return;
    }

    const fipeValue = parseCurrency(fipeData.price);
    const view: View = { ...base, fipe: { value: fipeValue, model: fipeData.model, reference: fipeData.referenceMonth, approximate: 'approximate' in fipeData ? fipeData.approximate === true : false } };
    updateResults(container, view);
    const results = calculate(fipeValue, bidValue, settings, pageFees);
    notes.get(container)?.setMaxBid(results.maxBid);
    container.dataset.state = 'done';
    reportRadar(container, ctx, { profit: results.profit, score: dealScore(results, risks).score, risks });
  } catch (e) {
    if (container.dataset.run !== run) return;
    container.dataset.state = 'error';
    updateResults(container, base);
    const limited = e instanceof FipeError && e.kind === 'rate-limit';
    const retry = `<button type="button" class="fipe-retry">${ICON.refresh}Tentar novamente</button>`;
    getResultsContainer(container).insertAdjacentHTML('afterbegin', limited
      ? alertHtml(ICON.clock, 'Limite da API FIPE excedido. Tente mais tarde ou informe um token no popup.', 'Lotes já consultados continuam usando a cópia guardada.', retry)
      : alertHtml(ICON.offline, 'Não foi possível consultar a FIPE. Verifique sua conexão.', '', retry, 'bad'));
    container.querySelector<HTMLButtonElement>('.fipe-retry')?.addEventListener('click', () => {
      void FipeService.retryNow().then(() => renderEvaluation(container, ctx, override));
    });
    reportRadar(container, ctx, { profit: null, score: null, risks });
  }
}

function openManual(container: HTMLElement) {
  const ctx = contexts.get(container);
  if (!ctx) return;
  void getSettings().then(settings => {
    const input = { detected: parseDescription(ctx.description), initial: overrides.get(container), ipvaFee: settings.ipvaFee };
    showVehiclePicker(input, async (picked, ipvaFee) => {
      overrides.set(container, picked);
      await setIpvaFee(ipvaFee);
      await renderEvaluation(container, ctx, picked);
    });
  });
}

let toggleTimer: number | null = null;

function buildControls(container: HTMLElement) {
  const controls = container.querySelector<HTMLElement>('.fipe-controls');
  if (!controls || controls.childElementCount > 0) return;
  const uid = container.id || `fipe-lot-${++lotSeq}`;

  controls.innerHTML = `
    <span class="fipe-logo">${LOGO}</span>
    <div class="fipe-brand"><span class="fipe-brand-name">Astral Comet</span><span class="fipe-brand-sub">FIPE e lucro do lote</span></div>
    <span class="fipe-best" hidden>★ Melhor do leilão</span>
    <label class="fipe-toggle" title="Consulta automática">
      <input type="checkbox" class="fipe-auto-toggle" role="switch" aria-label="Consulta automática" />
      <span class="fipe-switch" aria-hidden="true"></span><span class="fipe-toggle-text">Auto</span>
    </label>`;
  const toggle = controls.querySelector<HTMLInputElement>('.fipe-auto-toggle')!;
  toggle.addEventListener('change', () => {
    if (toggleTimer !== null) window.clearTimeout(toggleTimer);
    toggleTimer = window.setTimeout(() => {
      toggleTimer = null;
      void setStored({ [AUTO_LOOKUP_KEY]: toggle.checked });
    }, 500);
  });

  const lotPanel = notes.get(container)?.panel;
  const tabs = document.createElement('div');
  tabs.className = 'fipe-tabs';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Painéis do lote');
  tabs.innerHTML = `<button type="button" class="fipe-tab" data-tab="costs" aria-expanded="false" aria-controls="${uid}-costs">Detalhamento dos custos${ICON.chevron}</button>${lotPanel
    ? `<button type="button" class="fipe-tab" data-tab="lot" aria-expanded="false" aria-controls="${lotPanel.id}">Meu lote <span class="fipe-tab-count">(${container.dataset.lotCount ?? '0/6'})</span>${ICON.chevron}</button>` : ''}`;
  const details = document.createElement('div');
  details.className = 'fipe-details fipe-panel';
  details.id = `${uid}-costs`;
  details.hidden = true;
  getResultsContainer(container).after(tabs, details);
  tabs.addEventListener('click', (event) => {
    const tab = (event.target as Element).closest<HTMLButtonElement>('.fipe-tab');
    if (!tab) return;
    container.dataset.tab = container.dataset.tab === tab.dataset.tab ? '' : tab.dataset.tab!;
    applyTabs(container);
  });

  const foot = document.createElement('div');
  foot.className = 'fipe-foot';
  foot.innerHTML = `<button type="button" class="fipe-manual-btn">${ICON.search}Selecionar veículo</button>`;
  foot.querySelector('button')!.addEventListener('click', () => openManual(container));
  container.append(foot);
  applyTabs(container);
}
let lotSeq = 0;

function setLotProgress(container: HTMLElement, done: number, total: number) {
  container.dataset.lotCount = `${done}/${total}`;
  const count = container.querySelector('.fipe-tab-count');
  if (count) count.textContent = `(${done}/${total})`;
}

async function renderWithMode(container: HTMLElement, ctx: LotContext) {
  if (isContextInvalidated()) {
    showInvalidatedNotice(container);
    return;
  }

  const auto = await getAutoLookupEnabled();
  const sig = `${ctx.description}|${ctx.bidText}|${auto}`;
  contexts.set(container, ctx);

  if (container.dataset.sig === sig) return; // nothing changed since last render
  container.dataset.sig = sig;
  if (container.dataset.desc !== ctx.description) {
    overrides.delete(container);
    container.dataset.desc = ctx.description;
  }

  buildControls(container);
  const toggle = container.querySelector<HTMLInputElement>('.fipe-auto-toggle');
  if (toggle) toggle.checked = auto;

  if (auto || overrides.has(container)) {
    await renderEvaluation(container, ctx);
    return;
  }

  container.dataset.run = String(Number(container.dataset.run ?? '0') + 1);
  container.dataset.state = 'manual';
  container.style.borderLeftColor = '';
  setCosts(container, '');
  reportRadar(container, ctx, null);
  const parsed = parseDescription(ctx.description);
  const resultsEl = getResultsContainer(container);
  resultsEl.innerHTML = `
    <div class="fipe-manual-state">
      <span class="fipe-label">Modo manual</span>
      <span class="fipe-value">${parsed ? escapeHtml(`${parsed.brand} / ${parsed.model} (${parsed.modelYear})`) : 'Nenhum veículo detectado'}</span>
      <span class="fipe-maxbid-note">Consulta automática desligada: nada é gasto da cota até você pedir.</span>
      <div class="fipe-manual-actions">
        ${parsed ? '<button type="button" class="fipe-manual-once fipe-btn-primary">Consultar este lote</button>' : ''}
        <button type="button" class="fipe-manual-open">Abrir seleção</button>
      </div>
    </div>
  `;
  resultsEl.querySelector<HTMLButtonElement>('.fipe-manual-open')?.addEventListener('click', () => openManual(container));
  resultsEl.querySelector<HTMLButtonElement>('.fipe-manual-once')?.addEventListener('click', () => void renderEvaluation(container, ctx));
}

function findLotCards(): HTMLElement[] {
  const cards = new Set<HTMLElement>();

  document
    .querySelectorAll('.cardlote, .cardLote, [class*="cardLote"], [class*="card-lote"], a[href*="LoteDetalhes"]')
    .forEach(element => {
      if (element.closest('.fipe-helper-container')) return;
      const host = element instanceof HTMLAnchorElement
        ? element.closest('.card, article, li, [class*="card"], [class*="col-"]')
        : element;

      if (!(host instanceof HTMLElement)) return;
      if (!findDescriptionElement(host) || countDescriptions(host) > 1) return; // wrappers holding many lots are not cards
      cards.add(host);
    });

  // Class names such as "cardLote-descVeic" also match, so keep only the outermost card.
  return [...cards].filter(card => ![...cards].some(other => other !== card && other.contains(card)));
}

async function processLot(card: HTMLElement) {
  const descriptionElement = findDescriptionElement(card);
  if (!descriptionElement) return;

  const description = getTextContent(descriptionElement);
  const bidText = findBidText(card);
  const insertionTarget =
    card.querySelector<HTMLElement>('.cardLote-lance')?.parentElement ||
    card.querySelector<HTMLElement>('[class*="lance"]')?.parentElement ||
    card;

  const container = ensureContainer(card, insertionTarget as HTMLElement);
  await renderWithMode(container, { root: card, scope: card, description, bidText });
}

function isDetailPage(): boolean {
  return /LoteDetalhes/i.test(window.location.href);
}

async function processDetailPage() {
  const descriptionElement = findDescriptionElement(document);
  if (!descriptionElement) return;

  const description = getTextContent(descriptionElement);
  const bidText = findBidText(document);
  const host =
    descriptionElement.closest('.col-md-8') ||
    descriptionElement.closest('.card') ||
    document.querySelector('main') ||
    document.body;

  if (!(host instanceof HTMLElement)) return;

  const insertionTarget =
    descriptionElement.closest('.card') ||
    descriptionElement.parentElement ||
    host;

  const container = ensureContainer(host, insertionTarget as HTMLElement, DETAIL_PANEL_ID);
  if (container.parentElement !== insertionTarget) {
    insertionTarget.prepend(container);
  }

  if (!notes.has(container)) {
    const store = LotStore.fromChrome();
    if (store) notes.set(container, mountLotNotes(container, store, window.location.href, description, (done, total) => setLotProgress(container, done, total)));
  }
  // A page-wide host would pull menus and other lots into the red-flag scan; narrow it to the description's own block.
  const scope = host === document.body || host.tagName === 'MAIN' ? (descriptionElement.parentElement ?? host) : host;
  await renderWithMode(container, { root: document, scope, description, bidText });
}

let scanTimer: number | null = null;

function scanPage() {
  if (scanTimer !== null) {
    window.clearTimeout(scanTimer);
  }

  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    if (isDetailPage()) {
      void processDetailPage();
      return;
    }

    for (const card of findLotCards()) {
      void processLot(card);
    }
  }, 150);
}

/** True when a mutation was caused by the extension's own UI (which would otherwise re-trigger scans forever). */
function isOwnMutation(m: MutationRecord): boolean {
  const target = m.target instanceof Element ? m.target : m.target.parentElement;
  if (target?.closest(OWN_UI)) return true;
  const added = [...m.addedNodes, ...m.removedNodes];
  return added.length > 0 && added.every(n =>
    n instanceof Element && (n.matches(OWN_UI) || n.closest(OWN_UI)));
}

function rescanAll() {
  document.querySelectorAll<HTMLElement>('.fipe-helper-container').forEach(c => { delete c.dataset.sig; });
  scanPage();
}

if (window.self === window.top) {
  const start = () => {
    scanPage();

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(m => !isOwnMutation(m))) {
        scanPage();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Re-render when settings (or the auto-lookup toggle) change in the popup or another tab.
    globalThis.chrome?.storage?.onChanged?.addListener((_changes, area) => {
      if (area === 'sync') rescanAll();
    });
  };

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
}
