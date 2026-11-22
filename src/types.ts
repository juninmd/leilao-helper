export interface FipeVehicle {
  price: string;
  brand: string;
  model: string;
  modelYear: number;
  fuel: string;
  codeFipe: string;
  referenceMonth: string;
}

export type FipeErrorKind = 'rate-limit' | 'network' | 'not-found' | 'auth';

export interface CalculationResult {
  fipeValue: number;
  /** What the car is expected to sell for: FIPE minus the configured resale discount. */
  resaleValue: number;
  /** Margin over total cost that maxBid preserves, as a fraction (0 = break-even). */
  targetMargin: number;
  bidValue: number;
  commission: number;
  commissionRate: number;
  adminFee: number;
  logisticsFee: number;
  extraCosts: number;
  atpvFee: number;
  towing: number;
  ipvaFee: number;
  totalCost: number;
  /** Highest bid that still yields no loss against FIPE (0 when none does). */
  maxBid: number;
  profit: number;
  profitPercentage: number;
}
