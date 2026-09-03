import {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_LABELS,
  type CatalogItem,
} from '@core/catalog/schema';
import type { LatLng } from '@core/models';

import { IconDownload, IconSearch, IconSpinner, IconTarget } from '@/ui/Icons';
import { useCatalog } from './useCatalog';

function km(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${Math.round(meters / 1000)} km`;
}

function mb(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  return bytes < 1_048_576
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function ItemRow({
  item,
  distanceMeters,
  onLocate,
}: {
  item: CatalogItem;
  distanceMeters?: number;
  onLocate: (item: CatalogItem) => void;
}) {
  const size = mb(item.sizeBytes);
  return (
    <div className="row">
      <span className="row-dot" style={{ opacity: 0.75 }} />
      <span className="row-main">
        <span className="row-title" title={item.title}>
          {item.title}
        </span>
        <span className="row-meta">
          <span>{CATALOG_CATEGORY_LABELS[item.category]}</span>
          {item.region === undefined ? null : <span>{item.region}</span>}
          {distanceMeters === undefined ? null : <span className="num">{km(distanceMeters)}</span>}
          {size === null ? null : <span className="num">{size}</span>}
          <span>{item.format.toUpperCase()}</span>
        </span>
      </span>
      {item.bbox === undefined ? null : (
        <button
          type="button"
          className="row-action"
          title="Show on map"
          onClick={() => onLocate(item)}
        >
          <IconTarget size={14} />
        </button>
      )}
      <a
        className="row-action"
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        title="Open the source's file (we link, never rehost)"
      >
        <IconDownload size={14} />
      </a>
    </div>
  );
}

/**
 * The catalog browser.
 *
 * "Around you" is really "around the middle of the map": the playground has no
 * device GPS by design (see README), so the map centre stands in for a fix.
 * That turns out to be the more useful tool anyway — you can point it at
 * anywhere in the world and see what the catalog holds there.
 */
export function CatalogPanel({
  origin,
  onLocate,
}: {
  origin: LatLng | null;
  onLocate: (item: CatalogItem) => void;
}) {
  const cat = useCatalog(origin);
  const counts = cat.index?.categoryCounts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="search">
        <IconSearch />
        <input
          value={cat.query}
          onChange={(e) => cat.setQuery(e.currentTarget.value)}
          placeholder="Search the catalog…"
          spellCheck={false}
        />
        {cat.searching ? <IconSpinner size={13} className="spin" /> : null}
      </div>

      <div className="chips">
        <button
          type="button"
          className="chip"
          aria-pressed={cat.category === null}
          onClick={() => cat.setCategory(null)}
        >
          All
          {total > 0 ? <span className="chip-count">{total.toLocaleString()}</span> : null}
        </button>
        {CATALOG_CATEGORIES.filter((c) => (counts[c] ?? 0) > 0).map((c) => (
          <button
            key={c}
            type="button"
            className="chip"
            aria-pressed={cat.category === c}
            onClick={() => cat.setCategory(cat.category === c ? null : c)}
          >
            {CATALOG_CATEGORY_LABELS[c]}
            <span className="chip-count">{(counts[c] ?? 0).toLocaleString()}</span>
          </button>
        ))}
      </div>

      {cat.error !== null ? (
        <div className="note">Catalog unreachable — {cat.error}</div>
      ) : cat.loading ? (
        <div className="empty">Loading the live catalog…</div>
      ) : null}

      {cat.warnings.length > 0 ? (
        <div className="note">
          {cat.warnings.length} parse warning{cat.warnings.length === 1 ? '' : 's'} from{' '}
          <code>@core/catalog</code>: {cat.warnings.slice(0, 2).join('; ')}
        </div>
      ) : null}

      {cat.results !== null ? (
        <>
          <div className="micro section-label">
            {cat.results.length === 0
              ? cat.searchExhausted
                ? 'No match in the catalog'
                : 'No match in the shards fetched'
              : `${cat.results.length} result${cat.results.length === 1 ? '' : 's'}`}
          </div>
          {cat.results.map((item) => (
            <ItemRow key={item.id} item={item} onLocate={onLocate} />
          ))}
          {cat.results.length === 0 ? (
            <div className="empty">
              {cat.searchExhausted
                ? 'The search digest says no shard in the catalog holds this term.'
                : 'Nothing matched in the nearest shards. Pan the map closer to where you expect it.'}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="micro section-label">
            Around this view {cat.nearbyLoading ? '·  loading' : ''}
          </div>
          {cat.nearby.map(({ item, distanceMeters }) => (
            <ItemRow
              key={item.id}
              item={item}
              distanceMeters={distanceMeters}
              onLocate={onLocate}
            />
          ))}
          {cat.nearby.length === 0 && !cat.nearbyLoading && !cat.loading ? (
            <div className="empty">
              Nothing in the catalog within {`${800}`} km of here.
              <br />
              Try Québec, the Rockies, or the US southwest.
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
