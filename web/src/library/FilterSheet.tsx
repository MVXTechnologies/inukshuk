import { useCallback, useState } from 'react';

import { allCategories, type CustomCategory } from '@core/library/categories';
import {
  countActiveFilters,
  UNCATEGORIZED,
  type NumericRange,
  type TrackFilter,
} from '@core/library/filterTracks';

import { CategoryIcon } from '@/ui/CategoryIcon';

/**
 * The trail filter, ported from `TrackFilterDialog.tsx`.
 *
 * Same six criteria in the same order (category, date, distance, duration, D+,
 * pace), the same unit scaling into `TrackFilter`'s SI fields, the same
 * "blank means no bound" parsing, and the same four date presets. The predicate
 * itself is never reimplemented: `filterTracks` / `countActiveFilters` from
 * `@core/library/filterTracks` do the work, so "what matches" is identical to
 * the phone.
 *
 * It is an inline collapsible section rather than a modal dialog. The Library
 * here is already a floating panel over the map, and stacking a modal on top of
 * a floating panel is the kind of furniture the aesthetic gate exists to
 * prevent; expanding in place also keeps the result list visible while the
 * criteria change, which is the whole feedback loop.
 */

const DATE_PRESETS: readonly { label: string; days: number | null }[] = [
  { label: 'Any time', days: null },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '12 months', days: 365 },
];

/** Accepts a comma decimal separator (fr-CA keyboards); rejects negatives. */
function parseNumber(raw: string): number | undefined {
  const clean = raw.trim().replace(',', '.');
  if (clean === '') return undefined;
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function range(min: string, max: string, scale: number): NumericRange | undefined {
  const lo = parseNumber(min);
  const hi = parseNumber(max);
  if (lo === undefined && hi === undefined) return undefined;
  return {
    ...(lo === undefined ? {} : { min: lo * scale }),
    ...(hi === undefined ? {} : { max: hi * scale }),
  };
}

interface Draft {
  categories: string[];
  days: number | null;
  distMin: string;
  distMax: string;
  durMin: string;
  durMax: string;
  ascMin: string;
  ascMax: string;
  paceMin: string;
  paceMax: string;
}

const EMPTY_DRAFT: Draft = {
  categories: [],
  days: null,
  distMin: '',
  distMax: '',
  durMin: '',
  durMax: '',
  ascMin: '',
  ascMax: '',
  paceMin: '',
  paceMax: '',
};

/** Build the `@core` filter from the draft. Scales: km→m, h→s, min/km→s/km. */
function toFilter(d: Draft): TrackFilter {
  return {
    ...(d.categories.length === 0 ? {} : { categories: d.categories }),
    ...(d.days === null ? {} : { startedAt: { min: Date.now() - d.days * 86_400_000 } }),
    ...(() => {
      const r = range(d.distMin, d.distMax, 1000);
      return r === undefined ? {} : { distanceM: r };
    })(),
    ...(() => {
      const r = range(d.durMin, d.durMax, 3600);
      return r === undefined ? {} : { durationS: r };
    })(),
    ...(() => {
      const r = range(d.ascMin, d.ascMax, 1);
      return r === undefined ? {} : { ascentM: r };
    })(),
    ...(() => {
      const r = range(d.paceMin, d.paceMax, 60);
      return r === undefined ? {} : { paceSecPerKm: r };
    })(),
  };
}

export function FilterSheet({
  customCategories,
  onChange,
}: {
  customCategories: readonly CustomCategory[];
  onChange: (filter: TrackFilter) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  // Every edit applies immediately: there is no Apply button, because in a
  // panel that keeps the list on screen the result IS the confirmation.
  const edit = useCallback(
    (patch: Partial<Draft>) => {
      setDraft((prev) => {
        const next = { ...prev, ...patch };
        onChange(toFilter(next));
        return next;
      });
    },
    [onChange],
  );

  const categories = allCategories(customCategories);
  const active = countActiveFilters(toFilter(draft));

  return (
    <div className="sheet">
      <div className="micro section-label">Category</div>
      <div className="chips">
        {categories.map((c) => {
          const on = draft.categories.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className="chip cat"
              aria-pressed={on}
              style={
                on
                  ? {
                      borderColor: c.color,
                      borderWidth: 2,
                      background: `${c.color}26`,
                      color: 'inherit',
                    }
                  : undefined
              }
              onClick={() =>
                edit({
                  categories: on
                    ? draft.categories.filter((x) => x !== c.id)
                    : [...draft.categories, c.id],
                })
              }
            >
              <CategoryIcon icon={c.icon} size={13} color={c.color} />
              {c.name}
            </button>
          );
        })}
        <button
          type="button"
          className="chip cat"
          aria-pressed={draft.categories.includes(UNCATEGORIZED)}
          onClick={() =>
            edit({
              categories: draft.categories.includes(UNCATEGORIZED)
                ? draft.categories.filter((x) => x !== UNCATEGORIZED)
                : [...draft.categories, UNCATEGORIZED],
            })
          }
        >
          Uncategorized
        </button>
      </div>

      <div className="micro section-label">Date</div>
      <div className="chips">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="chip"
            aria-pressed={draft.days === p.days}
            onClick={() => edit({ days: p.days })}
          >
            {p.label}
          </button>
        ))}
      </div>

      <Range
        label="Distance"
        unit="km"
        min={draft.distMin}
        max={draft.distMax}
        onMin={(v) => edit({ distMin: v })}
        onMax={(v) => edit({ distMax: v })}
      />
      <Range
        label="Duration"
        unit="hours"
        min={draft.durMin}
        max={draft.durMax}
        onMin={(v) => edit({ durMin: v })}
        onMax={(v) => edit({ durMax: v })}
      />
      <Range
        label="Elevation gain D+"
        unit="m"
        min={draft.ascMin}
        max={draft.ascMax}
        onMin={(v) => edit({ ascMin: v })}
        onMax={(v) => edit({ ascMax: v })}
      />
      <Range
        label="Pace"
        unit="min/km"
        min={draft.paceMin}
        max={draft.paceMax}
        onMin={(v) => edit({ paceMin: v })}
        onMax={(v) => edit({ paceMax: v })}
      />

      <div className="sheet-foot">
        <span className="micro">{active === 0 ? 'No filters' : `${active} active`}</span>
        <button
          type="button"
          className="chip"
          disabled={active === 0}
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            onChange({});
          }}
        >
          Clear all
        </button>
      </div>
    </div>
  );
}

function Range({
  label,
  unit,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  unit: string;
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  return (
    <>
      <div className="micro section-label">
        {label} <span className="unit">({unit})</span>
      </div>
      <div className="range-row">
        <input
          className="field num"
          inputMode="decimal"
          placeholder="Min"
          aria-label={`${label} minimum`}
          value={min}
          onChange={(e) => onMin(e.target.value)}
        />
        <span className="dash">–</span>
        <input
          className="field num"
          inputMode="decimal"
          placeholder="Max"
          aria-label={`${label} maximum`}
          value={max}
          onChange={(e) => onMax(e.target.value)}
        />
      </div>
    </>
  );
}
