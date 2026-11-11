/** "Radar do leilão": a floating summary of every lot evaluated on a list page, with sort and focus tools. */

export const LOGO = '<svg viewBox="0 0 40 40" width="32" height="32" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="#2a3156" stroke-width="1.5"/><g class="fipe-orbit"><circle cx="20" cy="3" r="3" fill="#9d8cff"/></g><path d="M11 27 22 16M14 29l11-11" stroke="#43e5a0" stroke-width="2.4" stroke-linecap="round"/><circle cx="26" cy="14" r="4.5" fill="#f3f5ff"/></svg>';

export interface RadarEntry {
  container: HTMLElement;
  /** The site's lot card the panel lives in. */
  card: HTMLElement;
  title: string;
  /** null while FIPE is unknown (not found, error). */
  profit: number | null;
  score: number | null;
  high: number;
}

type Sort = 'site' | 'profit' | 'score';
const GOOD_SCORE = 55;
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

const state = { sort: 'site' as Sort, only: false, collapsed: false };
let root: HTMLElement | null = null;
let lastHtml = '';
let entries: RadarEntry[] = [];

/** The ancestor of a card that is a direct child of a flex/grid container: CSS `order` can move it without touching the DOM. */
function flexItem(card: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = card; node?.parentElement && node.parentElement !== document.body; node = node.parentElement) {
    if (/flex|grid/.test(getComputedStyle(node.parentElement).display)) return node;
  }
  return null;
}

function sortable(list: RadarEntry[]): Map<RadarEntry, HTMLElement> | null {
  const items = new Map<RadarEntry, HTMLElement>();
  for (const e of list) {
    const item = flexItem(e.card);
    if (!item) return null;
    items.set(e, item);
  }
  const parents = new Set([...items.values()].map(i => i.parentElement));
  return parents.size === 1 ? items : null;
}

const best = (list: RadarEntry[]) => list.filter(e => e.profit !== null && e.profit > 0).sort((a, b) => b.profit! - a.profit!)[0] ?? null;

function html(list: RadarEntry[], canSort: boolean): string {
  const priced = list.filter(e => e.profit !== null);
  const opp = list.filter(e => (e.score ?? -1) >= GOOD_SCORE).length;
  const risky = list.filter(e => e.high > 0).length;
  const top = best(list);
  if (state.collapsed) {
    return `<button type="button" class="fipe-radar-pill" data-act="collapse" aria-expanded="false">${LOGO}<span>Radar · ${opp} ${opp === 1 ? 'oportunidade' : 'oportunidades'}</span></button>`;
  }
  const sortBtn = (key: Sort, label: string) => `<button type="button" data-act="sort" data-v="${key}" aria-pressed="${state.sort === key}">${label}</button>`;
  return `
    <span class="fipe-logo">${LOGO}</span>
    <div class="fipe-radar-info">
      <strong>Radar do leilão</strong>
      <span>${priced.length} de ${list.length} lotes com FIPE${top ? ` · melhor: ${escapeHtml(top.title)} (${brl.format(top.profit!)})` : ''}</span>
    </div>
    <div class="fipe-radar-chips">
      <span class="fipe-chip good">${opp} ${opp === 1 ? 'oportunidade' : 'oportunidades'}</span>
      ${risky ? `<span class="fipe-chip bad">${risky} com risco alto</span>` : ''}
    </div>
    <div class="fipe-radar-tools">
      ${canSort ? `<div class="fipe-seg" role="group" aria-label="Ordenar lotes">${sortBtn('site', 'Ordem do site')}${sortBtn('profit', 'Maior lucro')}${sortBtn('score', 'Maior nota')}</div>` : ''}
      <button type="button" class="fipe-radar-btn" data-act="only" aria-pressed="${state.only}">Só oportunidades</button>
      ${top ? '<button type="button" class="fipe-radar-btn" data-act="best">Ir ao melhor</button>' : ''}
      <button type="button" class="fipe-radar-btn fipe-radar-min" data-act="collapse" aria-expanded="true" aria-label="Minimizar radar">–</button>
    </div>`;
}

function setAttr(el: HTMLElement, name: string, value: string | null) {
  if (value === null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** Applies order/dimming only where it differs, so a stable page sees no writes at all. */
function layout(list: RadarEntry[]) {
  const items = sortable(list);
  const top = best(list);
  for (const e of list) {
    const badge = e.container.querySelector<HTMLElement>('.fipe-best');
    if (badge && badge.hidden !== (e !== top)) badge.hidden = e !== top;
    const target = items?.get(e) ?? e.card;
    setAttr(target, 'data-fipe-dim', state.only && (e.score ?? -1) < GOOD_SCORE ? '' : null);
  }
  if (!items) return;
  const key = (e: RadarEntry) => (state.sort === 'profit' ? e.profit : e.score) ?? -Infinity;
  const ranked = state.sort === 'site' ? [] : [...list].sort((a, b) => key(b) - key(a));
  for (const [e, item] of items) {
    const order = state.sort === 'site' ? '' : String(ranked.indexOf(e) + 1);
    if (item.style.order !== order) item.style.order = order;
  }
}

function onClick(event: MouseEvent) {
  const btn = (event.target as Element).closest<HTMLButtonElement>('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'sort') state.sort = btn.dataset.v as Sort;
  if (act === 'only') state.only = !state.only;
  if (act === 'collapse') state.collapsed = !state.collapsed;
  if (act === 'best') {
    const top = best(entries);
    if (top) {
      top.card.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      top.container.classList.remove('fipe-flash');
      void top.container.offsetWidth; // restart the animation
      top.container.classList.add('fipe-flash');
    }
  }
  updateRadar(entries);
  root?.querySelector<HTMLElement>(`[data-act="${act}"]${act === 'sort' ? `[data-v="${state.sort}"]` : ''}`)?.focus();
}

export function updateRadar(list: RadarEntry[]) {
  entries = list.filter(e => e.container.isConnected);
  if (entries.length < 2) {
    root?.remove();
    root = null;
    lastHtml = '';
    return;
  }
  if (!root) {
    root = document.createElement('div');
    root.className = 'fipe-radar';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Radar do leilão');
    root.addEventListener('click', onClick);
  }
  // Above the lot grid when there is one (never covering a lot); floating at the bottom otherwise.
  const grid = sortable(entries)?.values().next().value?.parentElement ?? null;
  if (grid) {
    if (root.nextElementSibling !== grid) grid.before(root);
  } else if (root.parentElement !== document.body) document.body.append(root);
  if (root.classList.contains('inline') !== Boolean(grid)) root.classList.toggle('inline', Boolean(grid));
  const markup = html(entries, sortable(entries) !== null);
  if (markup !== lastHtml) {
    root.innerHTML = markup;
    lastHtml = markup;
  }
  if (root.classList.contains('collapsed') !== state.collapsed) root.classList.toggle('collapsed', state.collapsed);
  layout(entries);
}
