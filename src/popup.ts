import { DEFAULTS, TOKEN_KEY, setStored } from './settings';
import { renderFavorites, renderQuota } from './popup_extras';
import { storageGet } from './storage';

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

async function loadSettings() {
  const res = await storageGet<Record<string, unknown>>('sync', [...fields, TOKEN_KEY]);
  const result = res.ok && res.value ? res.value : {};
  for (const f of fields) {
    const value = result[f];
    inputs[f].value = String(typeof value === 'number' && value >= 0 ? value : DEFAULTS[f]);
  }
  tokenInput.value = typeof result[TOKEN_KEY] === 'string' ? result[TOKEN_KEY] : '';
}

const MAX: Partial<Record<Field, number>> = { commissionRate: 100, resaleDiscount: 95, targetMargin: 1000 };

/** Parses an input as a non-negative number (comma accepted); falls back to the default when empty/invalid. */
function readField(f: Field): number {
  const value = parseFloat(inputs[f].value.replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return DEFAULTS[f];
  return Math.min(value, MAX[f] ?? Infinity);
}

async function saveSettings() {
  const values: Record<string, unknown> = { [TOKEN_KEY]: tokenInput.value.trim() };
  for (const f of fields) {
    values[f] = readField(f);
    inputs[f].value = String(values[f]);
  }

  const res = await setStored(values);
  if (res.ok) {
    errorMsg.style.display = 'none';
    void renderQuota(); // the token decides which limit applies
    successMsg.style.display = 'block';
    setTimeout(() => { successMsg.style.display = 'none'; }, 2000);
  } else {
    successMsg.style.display = 'none';
    errorMsg.style.display = 'block';
  }
}

function resetDefaults() {
  for (const f of fields) inputs[f].value = String(DEFAULTS[f]);
  void saveSettings();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void saveSettings();
});

resetBtn.addEventListener('click', resetDefaults);

void loadSettings();
void renderQuota();
void renderFavorites();
