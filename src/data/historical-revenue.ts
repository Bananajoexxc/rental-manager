/**
 * Historical revenue data from retired accounts (Daniel, Vertus).
 *
 * Daniel tracked total monthly revenue across ALL accounts (DB Cinema + Daniel + Vertus)
 * as it landed on his bank account. The numbers may be offset 1-2 weeks from actual
 * rental dates since payouts lag behind.
 *
 * To reconstruct per-account revenue:
 *   1. Subtract DB Cinema revenue already tracked in the rental table
 *   2. Split the remainder equally between Daniel and Vertus
 *
 * Damage costs = insurance claim payouts (additive revenue).
 * Business expenses (e.g., Leo payments) are already deducted in totalOverallMade.
 */

export interface HistoricalMonthData {
  /** YYYY-MM format */
  month: string;
  /** Base rental revenue across all accounts (before damage costs) */
  totalRevenue: number;
  /** Insurance/damage claim payouts — additive to revenue. 0 = unknown or not received */
  damageCosts: number;
  /** Business expenses already deducted (positive number, e.g. 256 for Leo payment) */
  businessExpenses: number;
  /** The definitive total Daniel received that month (revenue + damage - expenses) */
  totalOverallMade: number;
}

export const HISTORICAL_REVENUE: HistoricalMonthData[] = [
  // === 2022 Aug–Dec ===
  { month: '2022-08', totalRevenue: 172,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 172 },
  { month: '2022-09', totalRevenue: 105,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 105 },
  { month: '2022-10', totalRevenue: 152,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 152 },
  { month: '2022-11', totalRevenue: 423,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 423 },
  { month: '2022-12', totalRevenue: 272,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 272 },
  // === 2023 Jan–Dec ===
  { month: '2023-01', totalRevenue: 204,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 204 },
  { month: '2023-02', totalRevenue: 369,  damageCosts: 55,   businessExpenses: 0,   totalOverallMade: 424 },
  { month: '2023-03', totalRevenue: 614,  damageCosts: 600,  businessExpenses: 0,   totalOverallMade: 1214 },
  { month: '2023-04', totalRevenue: 559,  damageCosts: 450,  businessExpenses: 0,   totalOverallMade: 1009 },
  { month: '2023-05', totalRevenue: 420,  damageCosts: 130,  businessExpenses: 0,   totalOverallMade: 550 },
  { month: '2023-06', totalRevenue: 725,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 725 },
  { month: '2023-07', totalRevenue: 342,  damageCosts: 1318, businessExpenses: 0,   totalOverallMade: 1660 },
  { month: '2023-08', totalRevenue: 586,  damageCosts: 585,  businessExpenses: 0,   totalOverallMade: 1171 },
  { month: '2023-09', totalRevenue: 1002, damageCosts: 778,  businessExpenses: 0,   totalOverallMade: 1780 },
  { month: '2023-10', totalRevenue: 973,  damageCosts: 655,  businessExpenses: 0,   totalOverallMade: 1628 },
  { month: '2023-11', totalRevenue: 2466, damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 2466 },
  { month: '2023-12', totalRevenue: 1523, damageCosts: 170,  businessExpenses: 0,   totalOverallMade: 1693 },
  // === 2024 Jan–Jul (first batch) ===
  { month: '2024-01', totalRevenue: 3244, damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 3244 },
  { month: '2024-02', totalRevenue: 2630, damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 2630 },
  { month: '2024-03', totalRevenue: 3242, damageCosts: 330,  businessExpenses: 0,   totalOverallMade: 3572 },
  { month: '2024-04', totalRevenue: 2785, damageCosts: 100,  businessExpenses: 0,   totalOverallMade: 2885 },
  { month: '2024-05', totalRevenue: 2992, damageCosts: 282,  businessExpenses: 0,   totalOverallMade: 2992 },
  { month: '2024-06', totalRevenue: 3406, damageCosts: 419,  businessExpenses: 256, totalOverallMade: 3569 },
  { month: '2024-07', totalRevenue: 4414, damageCosts: 1464, businessExpenses: 0,   totalOverallMade: 5878 },
  // === 2024 Aug–Dec + 2025 Jan–Dec + 2026 Jan: damage-only overlay (~£7k / 18 months ≈ £389/mo) ===
  // totalRevenue=0 = sentinel: don't override tracked rental revenue, just add damage costs
  { month: '2024-08', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2024-09', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2024-10', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2024-11', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2024-12', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-01', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-02', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-03', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-04', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-05', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-06', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-07', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-08', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-09', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-10', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-11', totalRevenue: 0, damageCosts: 388, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-12', totalRevenue: 0, damageCosts: 388, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2026-01', totalRevenue: 0, damageCosts: 388, businessExpenses: 0, totalOverallMade: 0 },
];

/** Quick lookup by month key */
export function getHistoricalMonth(month: string): HistoricalMonthData | undefined {
  return HISTORICAL_REVENUE.find(h => h.month === month);
}

/** Earliest month in historical data */
export function getHistoricalStart(): string | undefined {
  return HISTORICAL_REVENUE.length > 0 ? HISTORICAL_REVENUE[0].month : undefined;
}

/** Latest month in historical data */
export function getHistoricalEnd(): string | undefined {
  return HISTORICAL_REVENUE.length > 0 ? HISTORICAL_REVENUE[HISTORICAL_REVENUE.length - 1].month : undefined;
}
