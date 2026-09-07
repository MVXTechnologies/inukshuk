import { useMemo, useState, type ReactNode } from 'react';

import type { BoundingBox } from '@core/models';

import { IconClose, IconDownload, IconFilter, IconSearch, IconSort, IconTarget } from '@/ui/Icons';
import { Menu, useMenuAnchor } from '@/ui/Menu';

import { StoreFilterSheet } from './StoreFilterSheet';
import {
  CATALOG,
  EMPTY_FILTER,
  LANG_LABEL,
  RADII,
  SIZE_LIMITS,
  activeGroups,
  countMatching,
  countryOf,
  formatBytes,
  formatCount,
  formatKm,
  matchingSheets,
  regionByCode,
  regionOf,
  scaleLabel,
  sourceOf,
  type StoreFilter,
  type StoreSheet,
} from './facets';

/**
 * The map store screen — the app's Search tab, as a design mockup (issue #250).
 *
 * The shape of the screen is the argument: a **count-first header**, a
 * **removable applied-filters strip**, then the list. Nothing about the current
 * store tells you how much of the catalogue you are looking at, so every state
 * here answers "how many, and why that many" before it shows a single row.
 *
 * The filter itself is a sheet rather than the Library's inline section, and
 * the reason is the shape of the data, not fashion: six groups and ~90 chips
 * would push the list a screen and a half down if they expanded in place. The
 * Library's principle is kept instead of its layout — the sheet stops short of
 * the top so the result count stays on screen and updates under your thumb,
 * and there is no Apply button.
 *
 * In `wide` the same sheet docks as a left column beside the results, which is
 * the other half of the question the Phone/Wide switch exists to ask.
 */

type StoreSort = 'near' | 'name' | 'size';

const SORTS: { key: StoreSort; label: string }[] = [
  { key: 'near', label: 'Nearest first' },
  { key: 'name', label: 'Name (A–Z)' },
  { key: 'size', label: 'Smallest download' },
];

/** How many rows the mockup draws. The count in the header is not capped. */
const MAX_ROWS = 60;

export function StorePanel({
  filter,
  onFilter,
  sheetOpen,
  onSheetOpen,
  wide,
  onLocate,
}: {
  filter: StoreFilter;
  onFilter: (next: StoreFilter) => void;
  sheetOpen: boolean;
  onSheetOpen: (open: boolean) => void;
  wide: boolean;
  onLocate: (bbox: BoundingBox) => void;
}) {
  const [sort, setSort] = useState<StoreSort>('near');
  const sortMenu = useMenuAnchor();

  const total = useMemo(() => countMatching(filter), [filter]);
  const rows = useMemo(() => {
    const list = matchingSheets(filter);
    if (sort === 'name') return [...list].sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'size') {
      return [...list].sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity));
    }
    return list;
  }, [filter, sort]);

  const active = activeGroups(filter);
  const pills = appliedPills(filter, onFilter);

  return (
    <>
      <div className="store-body">
        {sheetOpen && wide ? (
          <StoreFilterSheet
            filter={filter}
            onChange={onFilter}
            onClose={() => onSheetOpen(false)}
            wide
          />
        ) : null}

        <div className="store-results">
          <div className="search">
            <IconSearch />
            <input
              value={filter.query}
              onChange={(e) => onFilter({ ...filter, query: e.currentTarget.value })}
              placeholder="Search 67 983 sheets…"
              spellCheck={false}
            />
            {filter.query === '' ? null : (
              <button
                type="button"
                className="row-action"
                aria-label="Clear the search"
                onClick={() => onFilter({ ...filter, query: '' })}
              >
                <IconClose size={13} />
              </button>
            )}
          </div>

          <div className="lib-toolbar">
            <button
              type="button"
              className="tool"
              aria-pressed={sheetOpen}
              onClick={() => onSheetOpen(!sheetOpen)}
            >
              <IconFilter size={13} />
              Filter
              {active > 0 ? <span className="badge num">{active}</span> : null}
            </button>
            <button type="button" className="tool" onClick={sortMenu.open} title="Sort">
              <IconSort size={14} />
              {SORTS.find((s) => s.key === sort)?.label ?? 'Nearest first'}
            </button>
          </div>

          {sortMenu.anchor === null ? null : (
            <Menu
              anchor={sortMenu.anchor}
              onClose={sortMenu.close}
              items={SORTS.map((s) => ({
                key: s.key,
                label: s.label,
                checked: s.key === sort,
                onSelect: () => setSort(s.key),
              }))}
            />
          )}

          <div className="store-count">
            <span className="store-count-n num">{formatCount(total)}</span>
            <span className="store-count-label">
              {total === 1 ? 'map' : 'maps'}
              {active === 0 ? ' in the store' : ' match'}
            </span>
            <span className="spacer" />
            <span className="micro">
              {active === 0 ? 'no filters' : `${active} facet${active === 1 ? '' : 's'}`}
            </span>
          </div>

          {/* The applied strip: what is narrowing the list, each removable
              where it stands. It is above the results and not inside the sheet
              on purpose — after the sheet closes, this is the only thing left
              that explains the number. */}
          {pills.length === 0 ? null : (
            <div className="applied">
              {pills.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className="pill"
                  onClick={p.remove}
                  title={`Remove ${p.label}`}
                >
                  {p.icon}
                  {p.label}
                  <IconClose size={11} />
                </button>
              ))}
              <button
                type="button"
                className="pill clear"
                onClick={() => onFilter({ ...EMPTY_FILTER, query: filter.query })}
              >
                Clear all
              </button>
            </div>
          )}

          <div className="store-list">
            {rows.slice(0, MAX_ROWS).map((sheet) => (
              <SheetRow key={sheet.id} sheet={sheet} onLocate={onLocate} />
            ))}
            {rows.length === 0 ? (
              <div className="empty">
                Nothing in the sample matches.
                <br />
                {total > 0
                  ? `The catalogue holds ${formatCount(total)} — widen the radius to bring them into the mockup's sample.`
                  : 'Loosen a facet — the counts on the chips say which one is doing it.'}
              </div>
            ) : null}
            <p className="fixture-note">
              Counts are exact over all {formatCount(CATALOG.total)} sheets in{' '}
              <code>docs/catalog/v2</code> (built {CATALOG.generatedAt.slice(0, 10)}). The rows are
              a {formatCount(CATALOG.sampleSize)}-sheet sample carried in the mockup so the list is
              never empty; the phone would page the real shards.
            </p>
          </div>
        </div>
      </div>

      {sheetOpen && !wide ? (
        <>
          <button
            type="button"
            className="sheet-scrim"
            aria-label="Close filters"
            onClick={() => onSheetOpen(false)}
          />
          <StoreFilterSheet
            filter={filter}
            onChange={onFilter}
            onClose={() => onSheetOpen(false)}
            wide={false}
          />
        </>
      ) : null}
    </>
  );
}

function SheetRow({
  sheet,
  onLocate,
}: {
  sheet: StoreSheet;
  onLocate: (bbox: BoundingBox) => void;
}) {
  const source = sourceOf(sheet);
  const region = regionOf(sheet);
  const country = source === undefined ? undefined : countryOf(source.country);
  // The title already ends in "— US Topo" / "— CanTopo 021L14"; the badges say
  // the same thing better, so the row keeps the toponym and drops the suffix.
  const name = sheet.title.split(' — ')[0] ?? sheet.title;

  return (
    <div className="sheet-row">
      <span className="sheet-flag">{country?.flag ?? '🏳️'}</span>
      <span className="sheet-main">
        <span className="sheet-name" title={sheet.title}>
          {name}
        </span>
        <span className="sheet-meta">
          {source === undefined ? null : (
            <span className="scale-pill num">{scaleLabel(source.scale)}</span>
          )}
          {region === undefined ? null : (
            <span>
              {region.label}
              {region.derived ? <span className="approx">≈</span> : null}
            </span>
          )}
          {sheet.distanceKm === null ? null : (
            <span className="num">{formatKm(sheet.distanceKm)}</span>
          )}
          <span className="num">{formatBytes(sheet.sizeBytes)}</span>
        </span>
      </span>
      {sheet.bbox === null ? null : (
        <button
          type="button"
          className="row-action"
          title="Show on map"
          onClick={() => {
            const [west, south, east, north] = sheet.bbox ?? [0, 0, 0, 0];
            onLocate({ minLng: west, minLat: south, maxLng: east, maxLat: north });
          }}
        >
          <IconTarget size={14} />
        </button>
      )}
      <a
        className="row-action"
        href={sheet.url}
        target="_blank"
        rel="noreferrer noopener"
        title="Open the publisher's file (we link, never rehost)"
      >
        <IconDownload size={14} />
      </a>
    </div>
  );
}

interface Pill {
  key: string;
  label: string;
  icon?: ReactNode;
  remove: () => void;
}

/** The applied-filters strip, in the same order as the sheet's groups. */
function appliedPills(filter: StoreFilter, onFilter: (f: StoreFilter) => void): Pill[] {
  const pills: Pill[] = [];

  if (filter.maxDist !== null) {
    const km = RADII.find((r) => r.bucket === filter.maxDist)?.km;
    pills.push({
      key: 'dist',
      label: `Within ${formatCount(km ?? 0)} km`,
      icon: <IconTarget size={11} />,
      remove: () => onFilter({ ...filter, maxDist: null }),
    });
  }
  for (const code of filter.countries) {
    const c = countryOf(code);
    pills.push({
      key: `country-${code}`,
      label: `${c?.flag ?? ''} ${c?.label ?? code}`,
      remove: () => onFilter({ ...filter, countries: filter.countries.filter((x) => x !== code) }),
    });
  }
  for (const scale of filter.scales) {
    pills.push({
      key: `scale-${scale}`,
      label: scaleLabel(scale),
      remove: () => onFilter({ ...filter, scales: filter.scales.filter((x) => x !== scale) }),
    });
  }
  for (const code of filter.regions) {
    pills.push({
      key: `region-${code}`,
      label: regionByCode(code)?.label ?? code,
      remove: () => onFilter({ ...filter, regions: filter.regions.filter((x) => x !== code) }),
    });
  }
  for (const code of filter.langs) {
    pills.push({
      key: `lang-${code}`,
      label: LANG_LABEL[code] ?? code,
      remove: () => onFilter({ ...filter, langs: filter.langs.filter((x) => x !== code) }),
    });
  }
  if (filter.maxSize !== null) {
    const bytes = SIZE_LIMITS.find((s) => s.bucket === filter.maxSize)?.bytes;
    pills.push({
      key: 'size',
      label: `Under ${formatBytes(bytes ?? 0)}`,
      remove: () => onFilter({ ...filter, maxSize: null }),
    });
  }
  return pills;
}
