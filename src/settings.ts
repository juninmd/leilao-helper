import { Fees } from './lib';
import { storageGet, storageSet, StorageSetResult } from './storage';

export const DEFAULTS = {
  towing: 1500,
  extraCosts: 0,
  adminFee: 1900,
  logisticsFee: 1416,
  atpvFee: 40,
  /** Percent, as shown in the popup (5 = 5%). */
  commissionRate: 5,
  ipvaFee: 0,
  /** Percent under FIPE the car is expected to resell for. */
  resaleDiscount: 0,
  /** Percent profit wanted over the total cost. */
  targetMargin: 0,
};

export const AUTO_LOOKUP_KEY = 'astralCometAutoLookup';
export const TOKEN_KEY = 'fipeToken';

const FEE_KEYS = Object.keys(DEFAULTS);

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function getSettings(): Promise<Fees> {
  const res = await storageGet<Record<string, unknown>>('sync', FEE_KEYS);
  const r = res.ok && res.value ? res.value : {};
  return {
    towing: num(r.towing, DEFAULTS.towing),
    extraCosts: num(r.extraCosts, DEFAULTS.extraCosts),
    adminFee: num(r.adminFee, DEFAULTS.adminFee),
    logisticsFee: num(r.logisticsFee, DEFAULTS.logisticsFee),
    atpvFee: num(r.atpvFee, DEFAULTS.atpvFee),
    commissionRate: num(r.commissionRate, DEFAULTS.commissionRate) / 100,
    ipvaFee: num(r.ipvaFee, DEFAULTS.ipvaFee),
    resaleDiscount: Math.min(num(r.resaleDiscount, DEFAULTS.resaleDiscount), 95) / 100,
    targetMargin: num(r.targetMargin, DEFAULTS.targetMargin) / 100,
  };
}

export async function getAutoLookupEnabled(): Promise<boolean> {
  const res = await storageGet<Record<string, unknown>>('sync', [AUTO_LOOKUP_KEY]);
  if (!res.ok || !res.value) return true;
  return typeof res.value[AUTO_LOOKUP_KEY] === 'boolean' ? res.value[AUTO_LOOKUP_KEY] : true;
}

export function setStored(values: Record<string, unknown>): Promise<StorageSetResult> {
  return storageSet('sync', values);
}

export async function getToken(): Promise<string> {
  const res = await storageGet<Record<string, unknown>>('sync', [TOKEN_KEY]);
  if (!res.ok || !res.value) return '';
  const token = res.value[TOKEN_KEY];
  return typeof token === 'string' ? token.trim() : '';
}
