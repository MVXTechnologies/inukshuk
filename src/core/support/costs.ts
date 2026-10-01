/**
 * The public side of "Support Inukshuk" (#476): `docs/support/costs.json`,
 * read by both the website's support page and the app's Support screen.
 *
 * Owner rules (2026-09-30):
 * - no budget and no dollar amounts in public — only percentages;
 * - two goals funded in order: first "Keep the app up" (servers, store
 *   accounts, licences), then "Implement new features" (developer time).
 *   The active goal is the first one under 100 %; the ones before it show as
 *   funded. Goal amounts are set by the owner and never committed.
 *
 * Forgiving by design: every field is optional. A missing goal counts as 0 %,
 * unknown goals are ignored, percentages are clamped to 0–100, and a missing
 * field only hides the piece of the screen that needs it.
 *
 * Labels live here (EN; the website carries EN/FR), never in the JSON.
 *
 * Pure: no React Native / Expo imports.
 */

import type { Donor } from './donors';

export type GoalId = 'keepUp' | 'features';

export interface GoalInfo {
  id: GoalId;
  label: string;
  /** What this goal's donations pay for, in plain words, no amounts. */
  payFor: readonly string[];
}

/** In funding order. */
export const GOALS: readonly GoalInfo[] = [
  {
    id: 'keepUp',
    label: 'Keep the app up',
    payFor: [
      'Map servers and data',
      'App store accounts and licences',
      'Test devices and software',
    ],
  },
  { id: 'features', label: 'Implement new features', payFor: ['Developer time'] },
];

export interface GoalProgress {
  id: GoalId;
  /** 0–100. */
  percent: number;
}

export interface CostsDocument {
  year: number | null;
  /** Every known goal, in funding order; null when the file publishes no goals. */
  goals: GoalProgress[] | null;
  supporters: number | null;
  /** `YYYY-MM-DD` of the last update, or null. */
  updated: string | null;
  /** Prominent donors, published by hand after checking the store (may be empty). */
  donors: Donor[];
}

export interface CostsParseResult {
  doc: CostsDocument | null;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function parseDonor(raw: unknown): Donor | null {
  if (!isRecord(raw)) return null;
  const { name, place, since } = raw;
  if (!isNonEmptyString(name) || name.trim().length > 60) return null;
  return {
    name: name.trim(),
    place: isNonEmptyString(place) ? place.trim() : null,
    since: typeof since === 'number' && Number.isInteger(since) ? since : null,
  };
}

/** Clamp to a whole 0–100 percentage; null for anything that is not a finite number. */
export function clampPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)));
}

function parseGoals(raw: unknown, warnings: string[]): GoalProgress[] | null {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('costs: goals is not a list');
    return null;
  }
  const byId = new Map<string, number>();
  raw.forEach((row, i) => {
    const percent = isRecord(row) ? clampPercent(row.percent) : null;
    if (!isRecord(row) || typeof row.id !== 'string' || percent === null) {
      warnings.push(`costs: dropped goal row ${i}`);
      return;
    }
    byId.set(row.id, percent);
  });
  // Canonical order; a goal the file forgot counts as not yet funded.
  return GOALS.map((g) => ({ id: g.id, percent: byId.get(g.id) ?? 0 }));
}

/** Validate an untrusted `costs.json` payload. Never throws. */
export function parseCostsDocument(raw: unknown): CostsParseResult {
  if (!isRecord(raw)) return { doc: null, warnings: ['costs: not an object'] };
  const warnings: string[] = [];

  const year =
    typeof raw.year === 'number' && Number.isInteger(raw.year) && raw.year >= 2000
      ? raw.year
      : null;
  if (raw.year !== undefined && year === null) warnings.push('costs: invalid year');

  const supporters =
    typeof raw.supporters === 'number' && Number.isInteger(raw.supporters) && raw.supporters >= 0
      ? raw.supporters
      : null;
  if (raw.supporters !== undefined && supporters === null)
    warnings.push('costs: invalid supporters');

  const updated =
    typeof raw.updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.updated) ? raw.updated : null;

  const donors: Donor[] = [];
  (Array.isArray(raw.donors) ? raw.donors : []).forEach((row, i) => {
    const donor = parseDonor(row);
    if (donor) donors.push(donor);
    else warnings.push(`costs: dropped donor row ${i}`);
  });

  return {
    doc: { year, goals: parseGoals(raw.goals, warnings), supporters, updated, donors },
    warnings,
  };
}

export interface GoalsView {
  /** Goals fully funded, in order. */
  funded: GoalInfo[];
  /** The goal being funded now, or null when every goal is funded. */
  active: (GoalInfo & { percent: number }) | null;
}

/** Which goal to show as the bar, and which to show as done. */
export function goalsView(goals: readonly GoalProgress[]): GoalsView {
  const funded: GoalInfo[] = [];
  for (const info of GOALS) {
    const percent = goals.find((g) => g.id === info.id)?.percent ?? 0;
    if (percent < 100) return { funded, active: { ...info, percent } };
    funded.push(info);
  }
  return { funded, active: null };
}

/**
 * Whether a parsed document says anything worth showing. A file that parses
 * but carries none of the fields (a wrong URL serving some other JSON) must
 * not replace a good cached copy.
 */
export function hasContent(doc: CostsDocument): boolean {
  return doc.goals !== null || doc.supporters !== null || doc.donors.length > 0;
}
