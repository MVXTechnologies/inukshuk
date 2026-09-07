import { useMemo, useState, type ReactNode } from 'react';

import { IconChevron, IconClose, IconTarget } from '@/ui/Icons';

import {
  CATALOG,
  LANGS_PRESENT,
  LANG_LABEL,
  RADII,
  SCALES,
  SIZE_LIMITS,
  EMPTY_FILTER,
  activeGroups,
  distanceHistogram,
  facetCounts,
  formatBytes,
  formatCount,
  type StoreFilter,
} from './facets';

/**
 * The map store's filter surface (issue #250).
 *
 * ── Why the groups are in THIS order ──────────────────────────────────────
 * The catalogue is 67 983 sheets in one category (`topo`, 100 %), so a
 * category grid divides nothing and is not here. What divides the data is
 * where a sheet is, who published it and how detailed it is — so the order is
 * the order of the questions a person actually asks:
 *
 *  1. **Near me** — the only facet that turns 67 983 into a handful, and the
 *     reason someone opens a map store on a phone at a trailhead. It leads.
 *  2. **Country** — the coarsest real split (US 65 240 / CA 2 234 / AU 509),
 *     three tiles with a flag: instantly legible, and the parent of (3).
 *  3. **Scale** — what a person means by "detailed enough to walk with".
 *     Today it is 1:1 with the source, which the caption says out loud.
 *  4. **Region / province** — the second level under country. 67 of them, so
 *     the ten biggest under the current filter show and the rest expand.
 *  5. **Language** — en vs bilingual; it decides whether a sheet is usable in
 *     Québec, and it is the first thing that will grow when French sources land.
 *  6. **Download size** — the actual cost of the tap, on a phone, offline.
 *  7. **Activity / category** — visibly *coming soon*, because the schema has
 *     no `tags[]` yet. Shown, not faked: the shape of phase 2 is a design
 *     decision the owner should see now, and greyed chips say "planned" far
 *     better than a paragraph.
 *
 * Every option carries a live count summed over the whole catalogue (see
 * `facets.ts`), and an option that would return nothing is disabled with its
 * zero showing. That is not decoration: there is nothing at all within 25 km
 * of Québec City in today's catalogue, and a filter that lets you tap into an
 * empty list to find that out is the filter the owner already has.
 */

const HISTOGRAM_LABELS = ['25', '50', '100', '250', '500', '1k', '2.5k', '5k', '5k+'];

/** How many region chips show before the "more" expander. */
const REGION_PREVIEW = 10;

export function StoreFilterSheet({
  filter,
  onChange,
  onClose,
  wide,
}: {
  filter: StoreFilter;
  onChange: (next: StoreFilter) => void;
  onClose: () => void;
  wide: boolean;
}) {
  const [showAllRegions, setShowAllRegions] = useState(false);
  const counts = useMemo(() => facetCounts(filter), [filter]);
  const bars = useMemo(() => distanceHistogram(filter), [filter]);
  const active = activeGroups(filter);

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  // Regions are scoped to the chosen countries — a flat list of 67 with
  // Alaska's 11 177 at the top is a wall, and "which province" is a question
  // you only ask after "which country".
  const regionPool = useMemo(() => {
    const scoped =
      filter.countries.length === 0
        ? CATALOG.regions
        : CATALOG.regions.filter((r) => filter.countries.includes(r.country));
    return [...scoped]
      .map((r) => ({ ...r, live: counts.region.get(r.code) ?? 0 }))
      .sort((a, b) => b.live - a.live || a.label.localeCompare(b.label));
  }, [filter.countries, counts.region]);

  const shownRegions = showAllRegions
    ? regionPool
    : regionPool.filter((r, i) => i < REGION_PREVIEW || filter.regions.includes(r.code));

  return (
    <div className={`store-sheet${wide ? ' docked' : ''}`}>
      {wide ? null : <div className="sheet-grip" aria-hidden="true" />}

      <div className="sheet-head">
        <span className="micro">Filter the store</span>
        <span className="spacer" />
        <button type="button" className="row-action" onClick={onClose} aria-label="Close filters">
          <IconClose size={14} />
        </button>
      </div>

      <div className="sheet-scroll">
        {/* ------------------------------------------------------ 1. near me -- */}
        <Facet
          label="Near me"
          note={
            <>
              <IconTarget size={11} /> Québec City
            </>
          }
        >
          <div className="dist-hist" aria-hidden="true">
            {bars.map((n, i) => {
              const peak = Math.max(...bars, 1);
              const on = filter.maxDist === null || i <= filter.maxDist;
              return (
                <span key={HISTOGRAM_LABELS[i] ?? i} className={`dist-bar${on ? ' on' : ''}`}>
                  <span style={{ height: `${Math.max(2, Math.sqrt(n / peak) * 100)}%` }} />
                  <em>{HISTOGRAM_LABELS[i]}</em>
                </span>
              );
            })}
          </div>
          <div className="chips">
            {RADII.map((r) => {
              const n = counts.dist[r.bucket] ?? 0;
              return (
                <button
                  key={r.km}
                  type="button"
                  className="chip"
                  aria-pressed={filter.maxDist === r.bucket}
                  disabled={n === 0 && filter.maxDist !== r.bucket}
                  onClick={() =>
                    onChange({
                      ...filter,
                      maxDist: filter.maxDist === r.bucket ? null : r.bucket,
                    })
                  }
                >
                  {formatCount(r.km)} km
                  <span className="chip-count num">{formatCount(n)}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="chip"
              aria-pressed={filter.maxDist === null}
              onClick={() => onChange({ ...filter, maxDist: null })}
            >
              Anywhere
              <span className="chip-count num">
                {formatCount(counts.dist[counts.dist.length - 1] ?? 0)}
              </span>
            </button>
          </div>
        </Facet>

        {/* ------------------------------------------------------ 2. country -- */}
        <Facet label="Country" note={`${CATALOG.sources.length} sources`}>
          <div className="country-tiles">
            {CATALOG.countries.map((c) => {
              const n = counts.country.get(c.code) ?? 0;
              const on = filter.countries.includes(c.code);
              return (
                <button
                  key={c.code}
                  type="button"
                  className="country-tile"
                  aria-pressed={on}
                  disabled={n === 0 && !on}
                  onClick={() =>
                    onChange({ ...filter, countries: toggle(filter.countries, c.code) })
                  }
                >
                  <span className="flag">{c.flag}</span>
                  <span className="country-name">{c.label}</span>
                  <span className="country-count num">{formatCount(n)}</span>
                </button>
              );
            })}
          </div>
        </Facet>

        {/* -------------------------------------------------------- 3. scale -- */}
        <Facet label="Scale" note="one per source today">
          <div className="scale-row">
            {SCALES.map((s) => {
              const n = counts.scale.get(s.scale) ?? 0;
              const on = filter.scales.includes(s.scale);
              const source = CATALOG.sources.find((x) => x.scale === s.scale);
              return (
                <button
                  key={s.scale}
                  type="button"
                  className="scale-tile"
                  aria-pressed={on}
                  disabled={n === 0 && !on}
                  onClick={() => onChange({ ...filter, scales: toggle(filter.scales, s.scale) })}
                >
                  <span className="scale-badge num">{s.label}</span>
                  <span className="scale-src">{source?.short ?? ''}</span>
                  <span className="scale-count num">{formatCount(n)}</span>
                </button>
              );
            })}
          </div>
        </Facet>

        {/* ------------------------------------------------------- 4. region -- */}
        <Facet
          label="Region"
          note={
            filter.countries.length === 0
              ? `${regionPool.length} in the catalogue`
              : `${regionPool.length} in ${filter.countries.join(' · ')}`
          }
        >
          <div className="chips">
            {shownRegions.map((r) => {
              const on = filter.regions.includes(r.code);
              return (
                <button
                  key={r.code}
                  type="button"
                  className="chip region"
                  aria-pressed={on}
                  disabled={r.live === 0 && !on}
                  title={r.derived ? 'Region derived in the mockup — see the doc' : r.label}
                  onClick={() => onChange({ ...filter, regions: toggle(filter.regions, r.code) })}
                >
                  <span className="region-code num">{r.code.split('-')[1]}</span>
                  {r.label}
                  {r.derived ? <span className="approx">≈</span> : null}
                  <span className="chip-count num">{formatCount(r.live)}</span>
                </button>
              );
            })}
            {regionPool.length > shownRegions.length || showAllRegions ? (
              <button
                type="button"
                className="chip ghost"
                onClick={() => setShowAllRegions((v) => !v)}
              >
                {showAllRegions
                  ? 'Show fewer'
                  : `+ ${regionPool.length - shownRegions.length} more`}
                <IconChevron size={12} open={showAllRegions} />
              </button>
            ) : null}
          </div>
          {regionPool.some((r) => r.derived) ? (
            <p className="facet-foot">
              <span className="approx">≈</span> Canadian provinces are derived from each
              sheet&apos;s bbox <em>in this mockup</em>. The live catalogue publishes no{' '}
              <code>region</code> for CanTopo at all — that is a fetcher fix, not a UI one.
            </p>
          ) : null}
        </Facet>

        {/* ----------------------------------------------------- 5. language -- */}
        <Facet label="Language" note="matters in Québec">
          <div className="chips">
            {LANGS_PRESENT.map((code) => {
              const n = counts.lang.get(code) ?? 0;
              const on = filter.langs.includes(code);
              return (
                <button
                  key={code}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  disabled={n === 0 && !on}
                  onClick={() => onChange({ ...filter, langs: toggle(filter.langs, code) })}
                >
                  {LANG_LABEL[code] ?? code}
                  <span className="chip-count num">{formatCount(n)}</span>
                </button>
              );
            })}
          </div>
        </Facet>

        {/* --------------------------------------------------------- 6. size -- */}
        <Facet label="Download size" note="what the tap costs offline">
          <div className="chips">
            {SIZE_LIMITS.map((s) => {
              const n = counts.size[s.bucket] ?? 0;
              return (
                <button
                  key={s.bytes}
                  type="button"
                  className="chip"
                  aria-pressed={filter.maxSize === s.bucket}
                  disabled={n === 0 && filter.maxSize !== s.bucket}
                  onClick={() =>
                    onChange({
                      ...filter,
                      maxSize: filter.maxSize === s.bucket ? null : s.bucket,
                    })
                  }
                >
                  Under {formatBytes(s.bytes)}
                  <span className="chip-count num">{formatCount(n)}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="chip"
              aria-pressed={filter.maxSize === null}
              onClick={() => onChange({ ...filter, maxSize: null })}
            >
              Any size
              <span className="chip-count num">
                {formatCount(counts.size[counts.size.length - 1] ?? 0)}
              </span>
            </button>
          </div>
        </Facet>

        {/* ------------------------------------------------------ 7. phase 2 -- */}
        <Facet label="Activity" note="phase 2" soon>
          <div className="chips soon">
            {['Hiking', 'Ski', 'Paddle', 'Hunting', 'Cycling'].map((a) => (
              <span key={a} className="chip ghost">
                {a}
              </span>
            ))}
          </div>
          <div className="micro section-label">Map type</div>
          <div className="chips soon">
            {['Parks', 'Nautical', 'River runs', 'Geological', 'Aerial', 'Touristic'].map((c) => (
              <span key={c} className="chip ghost">
                {c}
              </span>
            ))}
          </div>
          <p className="facet-foot">
            Every sheet in the catalogue is <code>topo</code> — all 67 983 of them. These need{' '}
            <code>tags[]</code> / <code>activities[]</code> on <code>CatalogItem</code> and sources
            that are not topo maps, so they are shown as planned rather than built as chips that
            filter nothing.
          </p>
        </Facet>
      </div>

      <div className="sheet-actions">
        <span className="sheet-total">
          <b className="num">{formatCount(counts.total)}</b> maps
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="chip"
          disabled={active === 0}
          onClick={() => onChange({ ...EMPTY_FILTER, query: filter.query })}
        >
          Reset
        </button>
        <button type="button" className="chip solid" onClick={onClose}>
          Show results
        </button>
      </div>
    </div>
  );
}

function Facet({
  label,
  note,
  soon,
  children,
}: {
  label: string;
  note?: ReactNode;
  soon?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`facet${soon === true ? ' soon' : ''}`}>
      <div className="facet-head">
        <span className="micro">{label}</span>
        {note === undefined ? null : <span className="facet-note">{note}</span>}
        {soon === true ? <span className="soon-tag">Coming soon</span> : null}
      </div>
      {children}
    </section>
  );
}
