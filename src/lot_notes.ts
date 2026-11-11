import { parseAmount } from './lib';
import { CHECKLIST, LotRecord, LotStore, lotKey, MAX_NOTE, sanitize } from './lot_store';

export interface LotNotes {
  /** The tab panel holding favorite, checklist, target bid and notes. */
  panel: HTMLElement;
  /** Tells the panel the current computed maximum bid, to compare with the buyer's target. */
  setMaxBid(maxBid: number | null): void;
}

const STAR = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg>';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const SAVE_DELAY_MS = 400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Favorite, target bid, due-diligence checklist and notes for the lot on this page. Text only, never HTML. */
export function mountLotNotes(container: HTMLElement, store: LotStore, href: string, title: string, onProgress?: (done: number, total: number) => void): LotNotes {
  const key = lotKey(href);
  let record: LotRecord | null = null;
  let maxBid: number | null = null;
  let timer: number | undefined;
  let pending = false;
  const ownStamps = new Set<number>(); // change events caused by this page's own saves

  const fav = el('button', 'fipe-fav');
  fav.type = 'button';
  fav.innerHTML = STAR;
  fav.append(document.createTextNode('Favoritar lote'));
  const head = el('div', 'fipe-check-head');
  const headLabel = el('span', undefined, 'Checklist antes de dar lance');
  const headCount = el('span', 'fipe-check-count');
  head.append(headLabel, headCount);
  const bar = el('div', 'fipe-check-bar');
  bar.setAttribute('aria-hidden', 'true');
  const barFill = el('i');
  bar.append(barFill);
  const list = el('ul', 'fipe-checklist');
  const checkboxes = CHECKLIST.map(item => {
    const box = el('input', 'fipe-check');
    box.type = 'checkbox';
    box.value = item.id;
    const label = el('label');
    label.append(box, document.createTextNode(item.label));
    const li = el('li');
    li.append(label);
    list.append(li);
    return box;
  });

  const targetId = `fipe-target-${key.replace(/\W/g, '')}`;
  const targetLabel = el('label', 'fipe-target-label', 'Meu lance-alvo (R$)');
  targetLabel.htmlFor = targetId;
  const target = el('input', 'fipe-target');
  target.id = targetId;
  target.type = 'text';
  target.inputMode = 'decimal';
  target.placeholder = 'ex.: 12.000,00';
  const targetNote = el('p', 'fipe-target-note');
  targetNote.setAttribute('role', 'status');

  const noteLabel = el('label', 'fipe-target-label', 'Anotações');
  const note = el('textarea', 'fipe-note-field');
  note.id = `${targetId}-note`;
  noteLabel.htmlFor = note.id;
  note.maxLength = MAX_NOTE;
  note.rows = 3;
  note.placeholder = 'Estado do veículo, pendências, prazos…';

  const wrap = el('section', 'fipe-notes fipe-panel');
  wrap.id = `${targetId}-panel`;
  wrap.hidden = true;
  wrap.setAttribute('aria-label', 'Meu lote');
  wrap.append(fav, head, bar, list, targetLabel, target, targetNote, noteLabel, note);
  container.append(wrap);

  const render = () => {
    if (!record) return;
    fav.setAttribute('aria-pressed', String(record.fav)); // the label stays fixed; aria-pressed carries the state
    const done = record.checks.length;
    headCount.textContent = `${done}/${CHECKLIST.length}`;
    barFill.style.width = `${Math.round((done / CHECKLIST.length) * 100)}%`;
    onProgress?.(done, CHECKLIST.length);
    checkboxes.forEach(box => { box.checked = record!.checks.includes(box.value); });
    const goal = record.target;
    if (!goal || maxBid === null) { targetNote.textContent = ''; targetNote.className = 'fipe-target-note'; return; }
    const over = goal - maxBid;
    targetNote.className = `fipe-target-note${over > 0 ? ' negative' : ''}`;
    targetNote.textContent = over > 0
      ? `Seu alvo está ${brl.format(over)} acima do lance máximo.`
      : `Seu alvo está ${brl.format(-over)} abaixo do lance máximo.`;
  };

  // Text fields follow the record unless the buyer is typing in them.
  const syncInputs = () => {
    if (!record) return;
    if (document.activeElement !== target) target.value = record.target ? record.target.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
    if (document.activeElement !== note) note.value = record.note;
  };

  // Writes only the fields this page changed, on top of what is stored now: another tab or the popup may have
  // changed the others since this page loaded.
  const touched = new Set<keyof LotRecord>();
  const persist = async () => {
    pending = false;
    if (!record || touched.size === 0) return;
    const mine = record;
    const fields = [...touched];
    touched.clear();
    const merged: LotRecord = { ...(await store.get(key, href, title)), url: href, title };
    for (const field of fields) (merged as unknown as Record<string, unknown>)[field] = mine[field];
    record = merged;
    syncInputs();
    const stamp = Date.now();
    ownStamps.add(stamp);
    await store.save(key, merged, stamp);
    render();
  };
  const later = () => { pending = true; window.clearTimeout(timer); timer = window.setTimeout(() => void persist(), SAVE_DELAY_MS); };
  const change = (patch: Partial<LotRecord>, debounce = false) => {
    if (!record) return;
    record = { ...record, ...patch };
    (Object.keys(patch) as (keyof LotRecord)[]).forEach(field => touched.add(field));
    if (debounce) { later(); return; } // the target note is announced once typing pauses, not on every keystroke
    render();
    void persist();
  };

  fav.addEventListener('click', () => change({ fav: !record?.fav }));
  checkboxes.forEach(box => box.addEventListener('change', () => {
    const ids = checkboxes.filter(b => b.checked).map(b => b.value);
    change({ checks: ids });
  }));
  target.addEventListener('input', () => change({ target: target.value.trim() ? parseAmount(target.value) : 0 }, true));
  note.addEventListener('input', () => change({ note: note.value }, true));
  // Only flush what the buyer typed here: re-saving an untouched copy would undo a change made in the popup or another tab.
  window.addEventListener('pagehide', () => { if (pending) { window.clearTimeout(timer); void persist(); } });

  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[key];
    if (area !== 'local' || !change || !record) return;
    const next = sanitize(change.newValue, record);
    if (ownStamps.has(next.savedAt)) return;
    record = { ...record, fav: next.fav, checks: next.checks };
    if (document.activeElement !== target) record.target = next.target;
    if (document.activeElement !== note) record.note = next.note;
    syncInputs();
    render();
  });

  void store.get(key, href, title).then(loaded => {
    record = { ...loaded, url: href, title };
    target.value = loaded.target ? loaded.target.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
    note.value = loaded.note;
    render();
  });

  return { panel: wrap, setMaxBid(next) { maxBid = next; render(); } };
}
