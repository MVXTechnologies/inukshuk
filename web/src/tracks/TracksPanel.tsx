import type { BoundingBox } from '@core/models';

import { IconTarget, IconTrash } from '@/ui/Icons';
import type { StoredTrack } from './useTracks';

function dist(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

function dur(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

/**
 * Imported tracks, with the stats `@core/geo/track#computeTrackStats` derived —
 * the same distance / D+ / moving-time numbers the app's library shows.
 */
export function TracksPanel({
  tracks,
  onLocate,
  onRemove,
  onClear,
}: {
  tracks: readonly StoredTrack[];
  onLocate: (bbox: BoundingBox) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <>
      <div className="note">
        Drop a <b>.gpx</b> file anywhere on the map to draw it. Tracks are parsed by{' '}
        <code>@core/geo/gpx</code> and kept in this browser's IndexedDB — nothing is uploaded and
        nothing reaches the phone.
      </div>

      {tracks.length === 0 ? (
        <div className="empty">
          No tracks yet.
          <br />
          Drag a GPX file onto the window.
        </div>
      ) : (
        <>
          <div className="micro section-label">
            {tracks.length} track{tracks.length === 1 ? '' : 's'}
            <button
              type="button"
              onClick={onClear}
              style={{ float: 'right', color: 'inherit', font: 'inherit' }}
            >
              Clear all
            </button>
          </div>
          {tracks.map((t) => (
            <div className="row" key={t.id}>
              <span className="row-dot" style={{ background: t.color }} />
              <span className="row-main">
                <span className="row-title" title={t.name}>
                  {t.name}
                </span>
                <span className="row-meta num">
                  <span>{dist(t.stats.distanceM)}</span>
                  <span>{dur(t.stats.movingTimeS)}</span>
                  <span>+{Math.round(t.stats.ascentM)} m</span>
                  <span>−{Math.round(t.stats.descentM)} m</span>
                  <span>{t.stats.pointCount.toLocaleString()} pts</span>
                  {t.waypointCount > 0 ? <span>{t.waypointCount} wpt</span> : null}
                </span>
              </span>
              {t.stats.bbox === undefined ? null : (
                <button
                  type="button"
                  className="row-action"
                  title="Zoom to track"
                  onClick={() => {
                    if (t.stats.bbox !== undefined) onLocate(t.stats.bbox);
                  }}
                >
                  <IconTarget size={14} />
                </button>
              )}
              <button
                type="button"
                className="row-action danger"
                title="Remove"
                onClick={() => onRemove(t.id)}
              >
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}
