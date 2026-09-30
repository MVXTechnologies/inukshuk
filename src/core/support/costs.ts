/**
 * The public accounts behind "Support Inukshuk" (#476): the shape of
 * `docs/support/costs.json`, the one file both the website's support page and
 * the app's Support screen read, and its validation.
 *
 * The file is hand-edited once a month by the owner, so the parser is
 * forgiving about the parts that are decoration (a bad cost or ledger row is
 * dropped with a warning) and strict about the parts a screen cannot do
 * without (year, currency, goal, raised, supporters). A document that fails
 * the strict part parses to `null`, and the app simply hides the progress
 * block rather than showing a wrong number.
 *
 * Pure: no React Native / Expo imports (see AGENTS.md).
 */

export type CostPeriod = 'year' | 'month' | 'once';

export interface CostItem {
  labelEn: string;
  labelFr: string;
  /** In the document's currency, for one `period`. */
  amount: number;
  period: CostPeriod;
}

export interface LedgerRow {
  /** `YYYY-MM`. */
  month: string;
  costs: number;
  gifts: number;
  balance: number;
}

export interface CostsDocument {
  year: number;
  /** ISO 4217 code, e.g. `USD`. */
  currency: string;
  /** What the year costs; the progress bar's 100 %. */
  goal: number;
  raised: number;
  supporters: number;
  /** `YYYY-MM-DD` of the last update, or null when absent/invalid. */
  updated: string | null;
  costs: CostItem[];
  ledger: LedgerRow[];
}

export interface CostsParseResult {
  doc: CostsDocument | null;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

const PERIODS: readonly CostPeriod[] = ['year', 'month', 'once'];

function isPeriod(value: unknown): value is CostPeriod {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value);
}

function parseCost(raw: unknown): CostItem | null {
  if (!isRecord(raw)) return null;
  const { label_en: labelEn, label_fr: labelFr, amount, period } = raw;
  if (!isNonEmptyString(labelEn) || !isAmount(amount) || !isPeriod(period)) return null;
  return {
    labelEn: labelEn.trim(),
    // A missing French label falls back to the English one: better than a gap.
    labelFr: isNonEmptyString(labelFr) ? labelFr.trim() : labelEn.trim(),
    amount,
    period,
  };
}

function parseLedgerRow(raw: unknown): LedgerRow | null {
  if (!isRecord(raw)) return null;
  const { month, costs, gifts, balance } = raw;
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  if (!isAmount(costs) || !isAmount(gifts)) return null;
  // The balance can go negative (a month that cost more than it raised).
  if (typeof balance !== 'number' || !Number.isFinite(balance)) return null;
  return { month, costs, gifts, balance };
}

/** Validate an untrusted `costs.json` payload. Never throws. */
export function parseCostsDocument(raw: unknown): CostsParseResult {
  const warnings: string[] = [];
  if (!isRecord(raw)) return { doc: null, warnings: ['costs: not an object'] };

  const { year, currency, goal, raised, supporters, updated } = raw;
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 2000 || year > 3000) {
    return { doc: null, warnings: ['costs: invalid year'] };
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return { doc: null, warnings: ['costs: invalid currency'] };
  }
  if (!isAmount(goal) || goal === 0) return { doc: null, warnings: ['costs: invalid goal'] };
  if (!isAmount(raised)) return { doc: null, warnings: ['costs: invalid raised'] };
  if (typeof supporters !== 'number' || !Number.isInteger(supporters) || supporters < 0) {
    return { doc: null, warnings: ['costs: invalid supporters'] };
  }

  const costs: CostItem[] = [];
  const rawCosts = Array.isArray(raw.costs) ? raw.costs : [];
  if (!Array.isArray(raw.costs)) warnings.push('costs: missing costs list');
  rawCosts.forEach((row, i) => {
    const item = parseCost(row);
    if (item) costs.push(item);
    else warnings.push(`costs: dropped cost row ${i}`);
  });

  const ledger: LedgerRow[] = [];
  const rawLedger = Array.isArray(raw.ledger) ? raw.ledger : [];
  rawLedger.forEach((row, i) => {
    const item = parseLedgerRow(row);
    if (item) ledger.push(item);
    else warnings.push(`costs: dropped ledger row ${i}`);
  });

  return {
    doc: {
      year,
      currency,
      goal,
      raised,
      supporters,
      updated: typeof updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(updated) ? updated : null,
      costs,
      ledger,
    },
    warnings,
  };
}

/** What one cost line weighs over a year (a one-off cost counts for nothing). */
export function annualAmount(item: CostItem): number {
  switch (item.period) {
    case 'year':
      return item.amount;
    case 'month':
      return item.amount * 12;
    case 'once':
      return 0;
  }
}

/** The yearly running cost: the sum of every recurring line. */
export function annualTotal(costs: readonly CostItem[]): number {
  return costs.reduce((sum, item) => sum + annualAmount(item), 0);
}

/** Share of the goal raised, clamped to [0, 1] (a surplus fills the bar, no more). */
export function progressFraction(raised: number, goal: number): number {
  if (!(goal > 0) || !Number.isFinite(raised) || raised <= 0) return 0;
  return Math.min(1, raised / goal);
}
