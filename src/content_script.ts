import { FipeError, FipeService } from './fipe_service';
import { CalculationResult } from './types';
import { calculate, CURRENCY_PATTERN, extractCurrency, PageFees, parseCurrency, parseDescription } from './lib';
import { getAutoLookupEnabled, getSettings, getToken, setStored, AUTO_LOOKUP_KEY } from './settings';
import { isContextInvalidated, StorageSetResult } from './storage';
import { categoryOf, Selection, showVehiclePicker } from './vehicle_picker';
import { LotStore } from './lot_store';
import { LotNotes, mountLotNotes } from './lot_notes';
import { detectRisks, Risk } from './risks';

const VEHICLE_DESCRIPTION_PATTERN = /(?:[^/\s,]+\/)?[^/,]+\/[^,]+,\s*\d{2}\/\d{2}/i;
const DETAIL_PANEL_ID = 'fipe-detail-helper';
const COLOR_GOOD = '#059669';
const COLOR_BAD = '#dc2626';
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

const OWN_UI = '.fipe-helper-container, .fipe-modal-overlay';

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
        const normalized = inputValue.replace(',', '.');
        const value = parseFloat(normalized);
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

function row(label: string, value: string, extra = ''): string {
  return `<div class="fipe-row"${extra}><span class="fipe-label">${label}</span><span class="fipe-value">${value}</span></div>`;
}

function stat(label: string, value: string): string {
  return `<div class="fipe-stat"><span class="fipe-label">${label}</span><span class="fipe-value">${value}</span></div>`;
}

const percent = (fraction: number) => Number((fraction * 100).toFixed(2)).toLocaleString('pt-BR');

function risksBlock(risks: Risk[]): string {
  if (risks.length === 0) return '';
  const chips = risks.map(r => `<li class="fipe-risk ${r.level}">${escapeHtml(r.label)}</li>`).join('');
  return `<div class="fipe-risks-wrap"><ul class="fipe-risks" aria-label="Alertas do lote">${chips}</ul><span class="fipe-maxbid-note">Palavras de risco no texto do lote. Confira no edital.</span></div>`;
}

function maxBidBlock(r: CalculationResult): string {
  const goal = r.targetMargin > 0 ? `lucro de ${percent(r.targetMargin)}%` : 'sem prejuízo';
  const title = `<span class="fipe-label">Lance máximo (${goal})</span>`;
  if (r.maxBid <= 0) {
    return `<div class="fipe-maxbid negative">${title}<span class="fipe-value">Inviável</span><span class="fipe-maxbid-note">Os custos fixos superam a FIPE</span></div>`;
  }
  const gap = r.maxBid - r.bidValue;
  const note = gap >= 0 ? `Folga de ${brl.format(gap)} sobre o lance atual` : `Lance atual excede em ${brl.format(-gap)}`;
  return `<div class="fipe-maxbid${gap < 0 ? ' negative' : ''}">${title}<span class="fipe-value">${brl.format(r.maxBid)}</span><span class="fipe-maxbid-note">${note}</span></div>`;
}

function updateResults(container: HTMLElement, results: CalculationResult, fipe: { value: number; model: string; reference: string; approximate?: boolean } | null, risks: Risk[] = []) {
  const resultsEl = getResultsContainer(container);
  const pct = percent(results.commissionRate);
  const wasOpen = container.dataset.detailsOpen === 'true';
  const discounted = results.fipeValue > 0 && results.resaleValue !== results.fipeValue;

  const breakdown = `
    <details class="fipe-details"${wasOpen ? ' open' : ''}>
      <summary>Detalhamento dos custos</summary>
      ${[
        discounted ? row(`Revenda estimada (FIPE −${percent(1 - results.resaleValue / results.fipeValue)}%):`, brl.format(results.resaleValue)) : '',
        row('Lance (Maior/Inicial):', brl.format(results.bidValue)),
        row(`Comissão Leiloeiro (${pct}%):`, brl.format(results.commission)),
        row('Despesas Adm/Org/Dep:', brl.format(results.adminFee)),
        row('Despesas Logística:', brl.format(results.logisticsFee)),
        row('Custos Extras:', brl.format(results.extraCosts)),
        row('ATPV-e:', brl.format(results.atpvFee)),
        row('Guincho (Est.):', brl.format(results.towing)),
        results.ipvaFee > 0 ? row('IPVA (não pago):', brl.format(results.ipvaFee)) : '',
      ].join('')}
      ${results.ipvaFee > 0 ? '<p class="fipe-maxbid-note">IPVA somado por você. Confira no edital se é do comprador: a regra de débitos muda de leilão para leilão.</p>' : ''}
    </details>`;

  if (!fipe) {
    container.style.borderLeftColor = '';
    resultsEl.innerHTML = `${risksBlock(risks)}<div class="fipe-stats">${stat('Lance', brl.format(results.bidValue))}${stat('Custo Total', brl.format(results.totalCost))}</div>${breakdown}`;
    return;
  }

  const isPositive = results.profit > 0;
  const tone = isPositive ? '' : ' negative';
  container.style.borderLeftColor = isPositive ? COLOR_GOOD : COLOR_BAD;
  resultsEl.innerHTML = `
    ${risksBlock(risks)}
    <div class="fipe-hero${tone}">
      <span class="fipe-label">Lucro Estimado</span>
      <div class="fipe-profit${tone}">
        <span class="fipe-value">${brl.format(results.profit)}</span>
        <span class="fipe-badge${tone}">${results.profitPercentage.toFixed(1)}%</span>
      </div>
    </div>
    <div class="fipe-stats">
      ${stat('Valor FIPE', brl.format(fipe.value))}
      ${stat('Custo Total', brl.format(results.totalCost))}
    </div>
    ${maxBidBlock(results)}
    <span class="fipe-fipe-model">${escapeHtml(fipe.model)} · ${escapeHtml(fipe.reference)}${fipe.approximate ? ' · <span class="fipe-approx" title="A versão exata não foi identificada. Confira em Selecionar veículo.">aproximado</span>' : ''}</span>
    ${breakdown}
  `;
}

function showMessage(container: HTMLElement, message: string, cls = 'fipe-not-found') {
  getResultsContainer(container).innerHTML = `<div class="fipe-alert"><span class="${cls}">${escapeHtml(message)}</span></div>`;
}

function showInvalidatedNotice(container: HTMLElement) {
  container.dataset.state = 'invalidated';
  container.style.borderLeftColor = '';
  getResultsContainer(container).innerHTML = `
    <div class="fipe-alert">
      <span class="fipe-not-found">Recarregue a página para continuar usando a extensão</span>
      <button type="button" class="fipe-reload-btn fipe-retry">Recarregar página</button>
    </div>
  `;
  container.querySelector<HTMLButtonElement>('.fipe-reload-btn')?.addEventListener('click', () => {
    window.location.reload();
  });
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
    return;
  }

  const run = String(Number(container.dataset.run ?? '0') + 1);
  container.dataset.run = run;
  container.dataset.state = 'loading';
  getResultsContainer(container).innerHTML = '<div class="fipe-loading"><div class="fipe-skeleton"><span class="fipe-label">Consultando FIPE...</span><i></i><i></i></div></div>';

  const bidValue = parseCurrency(ctx.bidText);
  const [settings, token] = await Promise.all([getSettings(), getToken()]);
  const costs = calculate(0, bidValue, settings, extractFeesFromPage(ctx.root));
  const risks = detectRisks(textBlocks(ctx.scope));
  notes.get(container)?.setMaxBid(null);

  try {
    const fipeData = picked
      ? await FipeService.getPriceByCode(categoryOf(picked.categoryKey), picked.brandCode, picked.modelCode, picked.yearCode, token || undefined)
      : await FipeService.getPrice(parsed!.brand, parsed!.model, parsed!.modelYear, token || undefined);
    if (container.dataset.run !== run) return; // superseded by a newer render

    if (!fipeData) {
      container.dataset.state = 'notfound';
      updateResults(container, costs, null, risks);
      getResultsContainer(container).insertAdjacentHTML('beforeend',
        `<div class="fipe-alert"><span class="fipe-not-found">FIPE não encontrada para ${escapeHtml(`${parsed!.brand} ${parsed!.model} (${parsed!.modelYear})`)}</span></div>`);
      return;
    }

    const fipeValue = parseCurrency(fipeData.price);
    const results = calculate(fipeValue, bidValue, settings, extractFeesFromPage(ctx.root));
    updateResults(container, results, { value: fipeValue, model: fipeData.model, reference: fipeData.referenceMonth, approximate: 'approximate' in fipeData ? fipeData.approximate === true : false }, risks);
    notes.get(container)?.setMaxBid(results.maxBid);
    container.dataset.state = 'done';
  } catch (e) {
    if (container.dataset.run !== run) return;
    container.dataset.state = 'error';
    updateResults(container, costs, null, risks);
    const message = e instanceof FipeError && e.kind === 'rate-limit'
      ? 'Limite da API FIPE excedido. Tente mais tarde ou informe um token no popup.'
      : 'Não foi possível consultar a FIPE. Verifique sua conexão.';
    getResultsContainer(container).insertAdjacentHTML('beforeend',
      `<div class="fipe-alert"><span class="fipe-not-found">${escapeHtml(message)}</span><button type="button" class="fipe-retry">Tentar novamente</button></div>`);
    container.querySelector<HTMLButtonElement>('.fipe-retry')?.addEventListener('click', () => {
      void FipeService.retryNow().then(() => renderEvaluation(container, ctx, override));
    });
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

  // Remember whether the cost breakdown is open: results are rebuilt on every refresh. 'toggle' doesn't bubble.
  container.addEventListener('toggle', (event) => {
    if (event.target instanceof HTMLDetailsElement && event.target.classList.contains('fipe-details')) container.dataset.detailsOpen = String(event.target.open);
  }, true);

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'fipe-toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'fipe-auto-toggle';
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(document.createTextNode('Consulta automática'));

  const manualButton = document.createElement('button');
  manualButton.type = 'button';
  manualButton.className = 'fipe-manual-btn';
  manualButton.textContent = 'Selecionar veículo';

  toggle.addEventListener('change', () => {
    if (toggleTimer !== null) window.clearTimeout(toggleTimer);
    toggleTimer = window.setTimeout(() => {
      toggleTimer = null;
      void setStored({ [AUTO_LOOKUP_KEY]: toggle.checked });
    }, 500);
  });
  manualButton.addEventListener('click', () => openManual(container));

  controls.appendChild(toggleLabel);
  controls.appendChild(manualButton);
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
  const parsed = parseDescription(ctx.description);
  const resultsEl = getResultsContainer(container);
  resultsEl.innerHTML = `
    <div class="fipe-manual-state">
      <div>
        <span class="fipe-label">Modo manual</span><br>
        <span class="fipe-value">${parsed ? escapeHtml(`${parsed.brand} / ${parsed.model} (${parsed.modelYear})`) : 'Nenhum veículo detectado'}</span>
      </div>
      <button type="button" class="fipe-manual-open">Abrir seleção</button>
    </div>
  `;
  resultsEl.querySelector<HTMLButtonElement>('.fipe-manual-open')?.addEventListener('click', () => openManual(container));
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
    if (store) notes.set(container, mountLotNotes(container, store, window.location.href, description));
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
  if (target?.closest('.fipe-helper-container, .fipe-modal-overlay')) return true;
  const added = [...m.addedNodes, ...m.removedNodes];
  return added.length > 0 && added.every(n =>
    n instanceof Element && (n.matches('.fipe-helper-container, .fipe-modal-overlay') || n.closest('.fipe-helper-container, .fipe-modal-overlay')));
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
