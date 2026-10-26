import { describe, expect, it } from 'vitest';
import { calculate, expandYear, parseAmount, parseBidInput, parseCurrency, parseDescription } from '../src/lib';
import { Fees } from '../src/lib';

const fees: Fees = { towing: 1500, extraCosts: 0, adminFee: 1900, logisticsFee: 1416, atpvFee: 40, commissionRate: 0.05, ipvaFee: 0 };

describe('parseCurrency', () => {
  it.each([
    ['R$ 1.234,56', 1234.56],
    ['R$ 15.000,00', 15000],
    ['Lance: R$ 800,00 incremento', 800],
    ['R$0,99', 0.99],
    ['15000,5', 15000.5],
  ])('%s → %d', (text, value) => expect(parseCurrency(text)).toBe(value));
  it.each(['', 'abc', 'R$'])('invalid "%s" → 0', text => expect(parseCurrency(text)).toBe(0));
});

describe('parseDescription', () => {
  it('parses brand/model, YY/YY', () => {
    expect(parseDescription('FIAT/UNO MILLE, 08/09')).toEqual({ brand: 'FIAT', model: 'UNO MILLE', modelYear: 2009 });
  });
  it('skips the import prefix', () => {
    expect(parseDescription('I/VW/GOL 1.0 CITY, 12/13')).toEqual({ brand: 'VW', model: 'GOL 1.0 CITY', modelYear: 2013 });
  });
  it('handles 19xx years', () => {
    expect(parseDescription('VW/FUSCA, 74/75')?.modelYear).toBe(1975);
  });
  it('returns null for unparseable text', () => {
    expect(parseDescription('Sucata sem descrição')).toBeNull();
    expect(parseDescription('')).toBeNull();
  });
  it('expandYear: next year stays in this century', () => {
    expect(expandYear(27, new Date('2026-10-23'))).toBe(2027);
    expect(expandYear(28, new Date('2026-10-23'))).toBe(1928);
  });
});

describe('calculate', () => {
  it('sums every cost and computes profit', () => {
    const r = calculate(30000, 10000, fees);
    expect(r.commission).toBe(500);
    expect(r.totalCost).toBe(10000 + 500 + 1900 + 1416 + 0 + 40 + 1500);
    expect(r.profit).toBe(30000 - r.totalCost);
    expect(r.profitPercentage).toBeCloseTo((r.profit / r.totalCost) * 100);
  });
  it('page fees override settings', () => {
    const r = calculate(30000, 10000, fees, { commissionRate: 0.1, adminFee: 2000, logisticsFee: 0 });
    expect(r.commission).toBe(1000);
    expect(r.adminFee).toBe(2000);
    expect(r.logisticsFee).toBe(0);
    expect(r.commissionRate).toBe(0.1);
  });
  it('IPVA is charged only when not paid on the page', () => {
    expect(calculate(0, 0, { ...fees, ipvaFee: 800 }).ipvaFee).toBe(800);
    expect(calculate(0, 0, { ...fees, ipvaFee: 800 }, { ipvaPaid: true }).ipvaFee).toBe(0);
  });
  it('negative profit when FIPE is lower than the cost', () => {
    expect(calculate(5000, 10000, fees).profit).toBeLessThan(0);
  });
  describe('maxBid (highest bid that still breaks even)', () => {
    it('solves bid × (1 + commission) + fixed costs = FIPE, rounded down to the cent', () => {
      // (30000 − (1900+1416+40+1500)) / 1.05 = 23946.666…
      expect(calculate(30000, 10000, fees).maxBid).toBe(23946.66);
    });
    it('never loses money: profit is ≥ 0 at maxBid and < 0 one cent above', () => {
      const { maxBid } = calculate(30000, 0, fees);
      expect(calculate(30000, maxBid, fees).profit).toBeGreaterThanOrEqual(0);
      expect(calculate(30000, maxBid + 0.01, fees).profit).toBeLessThan(0);
    });
    it('does not depend on the current bid', () => {
      expect(calculate(30000, 99999, fees).maxBid).toBe(calculate(30000, 1, fees).maxBid);
    });
    it('follows page fees and unpaid IPVA', () => {
      const r = calculate(30000, 0, { ...fees, ipvaFee: 800 }, { commissionRate: 0.1, adminFee: 0, logisticsFee: 0 });
      // (30000 − (0+0+40+1500+800)) / 1.1
      expect(r.maxBid).toBe(25145.45);
    });
    it('is 0 (not negative) when fixed costs alone exceed FIPE', () => {
      expect(calculate(3000, 0, fees).maxBid).toBe(0);
    });
    it('is 0 when there is no FIPE value', () => {
      expect(calculate(0, 5000, fees).maxBid).toBe(0);
    });
  });
  describe('parseAmount (a number the buyer typed)', () => {
    it('reads pt-BR and plain forms', () => {
      expect(parseAmount('12.000,50')).toBe(12000.5);
      expect(parseAmount('R$ 12.000,50')).toBe(12000.5);
      expect(parseAmount('12000')).toBe(12000);
      expect(parseAmount('12.000')).toBe(12000);
      expect(parseAmount('1.234.567')).toBe(1234567);
    });
    it('treats a lone dot before one or two digits as a decimal point, not a thousands separator', () => {
      expect(parseAmount('15000.50')).toBe(15000.5);
      expect(parseAmount('12.5')).toBe(12.5);
    });
    it('never returns a negative or non-finite amount', () => {
      expect(parseAmount('-500')).toBe(0);
      expect(parseAmount('abc')).toBe(0);
      expect(parseAmount('')).toBe(0);
    });
  });
  describe('resale discount and target margin', () => {
    it('defaults keep the plain FIPE break-even (existing behaviour)', () => {
      const r = calculate(30000, 10000, fees);
      expect(r.resaleValue).toBe(30000);
      expect(calculate(30000, 10000, { ...fees, resaleDiscount: 0, targetMargin: 0 })).toEqual(r);
    });
    it('values the resale below FIPE: profit is measured against FIPE × (1 − discount)', () => {
      const r = calculate(30000, 10000, { ...fees, resaleDiscount: 0.2 });
      expect(r.resaleValue).toBe(24000);
      expect(r.profit).toBe(24000 - r.totalCost);
      expect(r.fipeValue).toBe(30000); // FIPE itself is still reported as is
    });
    it('maxBid with a margin: total cost may be at most resale / (1 + margin)', () => {
      const withMargin: Fees = { ...fees, targetMargin: 0.1 };
      const { maxBid } = calculate(30000, 0, withMargin);
      const at = calculate(30000, maxBid, withMargin);
      expect(at.profitPercentage).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(calculate(30000, maxBid + 0.01, withMargin).profitPercentage).toBeLessThan(10);
    });
    it('combines both: lower resale and a margin shrink the maximum bid', () => {
      const plain = calculate(30000, 0, fees).maxBid;
      const strict = calculate(30000, 0, { ...fees, resaleDiscount: 0.15, targetMargin: 0.1 }).maxBid;
      expect(strict).toBeLessThan(plain);
      // (30000 × 0.85 / 1.1 − 4856) / 1.05
      expect(strict).toBe(Math.floor(((25500 / 1.1 - 4856) / 1.05) * 100) / 100);
    });
    it('is 0 when the discount wipes out the margin over fixed costs', () => {
      expect(calculate(6000, 0, { ...fees, resaleDiscount: 0.5 }).maxBid).toBe(0);
    });
  });
  it('zero bid and zero fees does not divide by zero', () => {
    const zero: Fees = { towing: 0, extraCosts: 0, adminFee: 0, logisticsFee: 0, atpvFee: 0, commissionRate: 0, ipvaFee: 0 };
    expect(calculate(1000, 0, zero).profitPercentage).toBe(0);
  });
});

describe('parseBidInput (the auction bid input)', () => {
  it('reads Brazilian and plain formats as the same amount', () => {
    expect(parseBidInput('12.500,00')).toBe(12500);
    expect(parseBidInput('12500.00')).toBe(12500);
    expect(parseBidInput('12500')).toBe(12500);
  });

  it('turns invalid or negative text into 0', () => {
    expect(parseBidInput('abc')).toBe(0);
    expect(parseBidInput('-5')).toBe(0);
  });
});
