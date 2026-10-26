import { CalculationResult } from './types';

export const CURRENCY_PATTERN = /R\$\s*[\d.]+,\d{2}/i;

/** Extracts the first "R$ 1.234,56" occurrence from text. */
export function extractCurrency(text: string): string | null {
  return text.match(CURRENCY_PATTERN)?.[0] || null;
}

/** Parses a Brazilian currency string ("R$ 1.234,56") into a number. Returns 0 when no number is found. */
export function parseCurrency(text: string): number {
  const currency = extractCurrency(text) || text;
  const normalized = currency
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');

  const value = normalized ? parseFloat(normalized) : 0;
  return Number.isFinite(value) ? value : 0;
}

/** A non-negative amount typed by the user: "12.000,50", "12000" or "15000.50" (a lone dot before 1-2 digits is a decimal point). */
export function parseAmount(text: string): number {
  const cleaned = text.replace(/R\$|\s/gi, '');
  if (/^-/.test(cleaned)) return 0;
  const decimalDot = !cleaned.includes(',') && /^\d+\.\d{1,2}$/.test(cleaned);
  const normalized = decimalDot ? cleaned : cleaned.replace(/\./g, '').replace(',', '.');
  const value = parseFloat(normalized.replace(/[^\d.]/g, ''));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The value of the auction's bid input: "12.500,00", "12500.00" and "12500" are all 12500. Invalid or negative text is 0. */
export function parseBidInput(value: string): number {
  return parseAmount(value);
}

/** Two-digit model year → four digits (anything beyond next year is assumed to be 19xx). */
export function expandYear(twoDigits: number, now = new Date()): number {
  const current = now.getFullYear();
  const year = 2000 + twoDigits;
  return year > current + 1 ? 1900 + twoDigits : year;
}

// "I/TOYOTA HILUX ..." (imported): the first segment is a marker and the brand is the first word(s) of the next one.
const IMPORT_MARKERS = new Set(['I', 'IMP', 'IMPORTADO']);
const MULTIWORD_BRANDS = ['ALFA ROMEO', 'LAND ROVER', 'ASTON MARTIN', 'ROLLS ROYCE', 'GREAT WALL', 'HARLEY DAVIDSON', 'CAOA CHERY', 'MERCEDES BENZ'];

/** Parses "FIAT/UNO MILLE, 08/09" (optionally prefixed by "I/") into brand, model and model year. */
export function parseDescription(description: string): { brand: string; model: string; modelYear: number } | null {
  const match = description.match(/^(?:[^/]+\/)?([^/]+)\/(.+?),\s*(\d{2})\/(\d{2})/);
  if (!match) return null;

  let brand = match[1].trim();
  let model = match[2].trim();
  if (IMPORT_MARKERS.has(brand.toUpperCase())) {
    const upper = model.toUpperCase();
    const compound = MULTIWORD_BRANDS.find(b => upper === b || upper.startsWith(`${b} `));
    const [first, ...rest] = model.split(/\s+/);
    if (compound) { brand = model.slice(0, compound.length); model = model.slice(compound.length).trim(); }
    else if (rest.length) { brand = first; model = rest.join(' '); }
  }

  return { brand, model, modelYear: expandYear(parseInt(match[4], 10)) };
}

export interface Fees {
  towing: number;
  extraCosts: number;
  adminFee: number;
  logisticsFee: number;
  atpvFee: number;
  /** Rate as a fraction (0.05 = 5%). */
  commissionRate: number;
  ipvaFee: number;
  /** Expected resale below FIPE, as a fraction (0.1 = sells 10% under FIPE). */
  resaleDiscount?: number;
  /** Profit wanted over the total cost, as a fraction (0.1 = 10%). */
  targetMargin?: number;
}

/** Fees read from the lot page, which take precedence over user settings. */
export interface PageFees {
  adminFee?: number;
  logisticsFee?: number;
  commissionRate?: number;
  ipvaPaid?: boolean;
}

export function calculate(fipe: number, bid: number, settings: Fees, pageFees: PageFees = {}): CalculationResult {
  const commissionRate = pageFees.commissionRate ?? settings.commissionRate;
  const commission = bid * commissionRate;
  const adminFee = pageFees.adminFee ?? settings.adminFee;
  const logisticsFee = pageFees.logisticsFee ?? settings.logisticsFee;
  const ipvaFee = pageFees.ipvaPaid ? 0 : settings.ipvaFee;

  const fixedCosts = adminFee + logisticsFee + settings.extraCosts + settings.atpvFee + settings.towing + ipvaFee;
  const totalCost = bid + commission + fixedCosts;
  const resaleValue = fipe * (1 - (settings.resaleDiscount ?? 0));
  const profit = resaleValue - totalCost;
  // Cost may be at most resale / (1 + margin); solve bid × (1 + commission) + fixed = that. Rounded down so the bid never overshoots by a cent.
  const costLimit = resaleValue / (1 + (settings.targetMargin ?? 0));
  const maxBid = Math.max(0, Math.floor(((costLimit - fixedCosts) / (1 + commissionRate)) * 100) / 100);
  const profitPercentage = totalCost > 0 ? (profit / totalCost) * 100 : 0;

  return {
    fipeValue: fipe,
    resaleValue,
    targetMargin: settings.targetMargin ?? 0,
    bidValue: bid,
    commission,
    commissionRate,
    adminFee,
    logisticsFee,
    extraCosts: settings.extraCosts,
    atpvFee: settings.atpvFee,
    towing: settings.towing,
    ipvaFee,
    totalCost,
    maxBid,
    profit,
    profitPercentage,
  };
}
