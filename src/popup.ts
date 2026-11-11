import { DEFAULTS, TOKEN_KEY, setStored } from './settings';
import { renderFavorites, renderQuota } from './popup_extras';
import { storageGet } from './storage';
import { calculate } from './lib';

const fields = ['commissionRate', 'adminFee', 'logisticsFee', 'towing', 'extraCosts', 'resaleDiscount', 'targetMargin'] as const;
type Field = typeof fields[number];

const inputs = Object.fromEntries(
  fields.map(f => [f, document.getElementById(f) as HTMLInputElement])
) as Record<Field, HTMLInputElement>;
const tokenInput = document.getElementById('fipeToken') as HTMLInputElement;
const form = document.getElementById('config-form') as HTMLFormElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const successMsg = document.getElementById('success') as HTMLDivElement;
const errorMsg = document.getElementById('error') as HTMLDivElement;

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const PREVIEW_FIPE = 30000;

/** "Prévia ao vivo": the max bid these settings give a R$ 30.000 FIPE car, recomputed as the buyer types. */
function renderPreview() {
  const max = document.getElementById('previewMax');
  const sub = document.getElementById('previewSub');
  if (!max || !sub) return;
  const v = Object.fromEntries(fields.map(f => [f, readField(f)])) as Record<Field, number>;
  const r = calculate(PREVIEW_FIPE, 0, {
    commissionRate: v.commissionRate / 100, adminFee: v.adminFee, logisticsFee: v.logisticsFee, towing: v.towing,
    extraCosts: v.extraCosts, atpvFee: DEFAULTS.atpvFee, ipvaFee: 0, resaleDiscount: v.resaleDiscount / 100, targetMargin: v.targetMargin / 100,
  });
  max.textContent = r.maxBid > 0 ? brl.format(r.maxBid) : 'Inviável';
  max.classList.toggle('bad', r.maxBid <= 0);
  sub.textContent = `Custos fixos ${brl.format(r.totalCost)} · revenda ${brl.format(r.resaleValue)}`;
}

/** Each % field has a slider twin; both stay in step. */
function linkRange(field: Field) {
  const range = document.getElementById(`${field}Range`) as HTMLInputElement | null;
  if (!range) return () => {};
  const sync = () => { range.value = String(Math.min(Number(range.max), readField(field))); };
  range.addEventListener('input', () => { inputs[field].value = range.value; renderPreview(); });
  inputs[field].addEventListener('input', sync);
  return sync;
}
const rangeSyncs = (['resaleDiscount', 'targetMargin'] as const).map(linkRange);

function selectTab(tab: HTMLElement, focus = false) {
  document.querySelectorAll<HTMLElement>('[role="tab"]').forEach(t => {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute('aria-controls') ?? '');
    if (panel) panel.hidden = !on;
  });
  document.body.dataset.tab = tab.id.replace('tab-', '');
  if (focus) tab.focus();
}
const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step) { e.preventDefault(); selectTab(tabs[(i + step + tabs.length) % tabs.length], true); }
  });
});

async function loadSettings() {
  const res = await storageGet<Record<string, unknown>>('sync', [...fields, TOKEN_KEY]);
  const result = res.ok && res.value ? res.value : {};
  for (const f of fields) {
    const value = result[f];
    inputs[f].value = String(typeof value === 'number' && value >= 0 ? value : DEFAULTS[f]);
  }
  tokenInput.value = typeof result[TOKEN_KEY] === 'string' ? result[TOKEN_KEY] : '';
  rangeSyncs.forEach(sync => sync());
  renderPreview();
}

const MAX: Partial<Record<Field, number>> = { commissionRate: 100, resaleDiscount: 95, targetMargin: 1000 };

/** Parses an input as a non-negative number (comma accepted); falls back to the default when empty/invalid. */
function readField(f: Field): number {
  const value = parseFloat(inputs[f].value.replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return DEFAULTS[f];
  return Math.min(value, MAX[f] ?? Infinity);
}

let toastTimer: number | undefined;

async function saveSettings() {
  const values: Record<string, unknown> = { [TOKEN_KEY]: tokenInput.value.trim() };
  for (const f of fields) {
    values[f] = readField(f);
    inputs[f].value = String(values[f]);
  }
  rangeSyncs.forEach(sync => sync());
  renderPreview();

  const res = await setStored(values);
  if (res.ok) {
    errorMsg.style.display = 'none';
    void renderQuota(); // the token decides which limit applies
    successMsg.style.display = 'block';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { successMsg.style.display = 'none'; }, 2200);
  } else {
    successMsg.style.display = 'none';
    errorMsg.style.display = 'block';
  }
}

function resetDefaults() {
  for (const f of fields) inputs[f].value = String(DEFAULTS[f]);
  void saveSettings();
}

form.addEventListener('input', renderPreview);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  void saveSettings();
});

resetBtn.addEventListener('click', resetDefaults);

void loadSettings();
void renderQuota();
void renderFavorites();
