import { useCallback, useEffect, useMemo, useState } from 'react';

import { haversineMeters } from '@core/geo/geomath';
import { retargetNotesAfterTrim, sliceTrack } from '@core/geo/gpx/edit';
import type { TrackPointAt } from '@core/geo/track';
import { findCategory } from '@core/library/categories';
import { orderNotes } from '@core/library/notes';
import type { TrackPoint } from '@core/models';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  formatTimestamp,
} from '@lib/format';

import type { LibraryState } from '@/library/useLibrary';
import { CategoryIcon } from '@/ui/CategoryIcon';
import { IconBack, IconDots, IconScissors, IconTag, IconTarget, IconTrash } from '@/ui/Icons';
import { Menu, useMenuAnchor, type MenuItem } from '@/ui/Menu';

import { ElevationProfile } from './ElevationProfile';
import { TrimSlider } from './TrimSlider';

/**
 * Where the scissors live. **This switch is the point of the screen.**
 *
 * `docs/BACKLOG.md`, "Queued (owner requests)", item 6: *move the trim
 * (scissors) button out of trail focus — it edits the GPX (different from map
 * viewing); move it next to the GPX title (right side) or to the bottom of the
 * trail view.* Rather than pick one and argue about it in prose, all three live
 * here behind `?trimAt=`, so the two candidates can be compared against the
 * thing they would replace in the same screenshot session.
 *
 *  - `rail`   — today's app: a floating FAB on the right edge, over the map.
 *  - `title`  — candidate A: an icon button beside the trail name.
 *  - `bottom` — candidate B: a full-width action under the profile.
 */
export type TrimPlacement = 'rail' | 'title' | 'bottom';

export const TRIM_PLACEMENTS: readonly { key: TrimPlacement; label: string }[] = [
  { key: 'rail', label: 'Rail' },
  { key: 'title', label: 'Title' },
  { key: 'bottom', label: 'Bottom' },
];

export const isTrimPlacement = (v: string): v is TrimPlacement =>
  TRIM_PLACEMENTS.some((p) => p.key === v);

export interface TrimState {
  start: number;
  end: number;
}

export function TrailFocus({
  lib,
  trackId,
  points,
  placement,
  onPlacement,
  trim,
  onTrim,
  onBack,
  onLocate,
  onScrub,
  onToast,
}: {
  lib: LibraryState;
  trackId: string;
  points: readonly TrackPoint[];
  placement: TrimPlacement;
  onPlacement: (p: TrimPlacement) => void;
  trim: TrimState | null;
  onTrim: (t: TrimState | null) => void;
  onBack: () => void;
  onLocate: () => void;
  onScrub: (at: TrackPointAt | null) => void;
  onToast: (message: string) => void;
}) {
  const menu = useMenuAnchor();
  const [busy, setBusy] = useState(false);
  const track = lib.index.tracks.find((t) => t.id === trackId);

  // Prefix distances: the trim readout, the profile's dimmed cut ends and the
  // note re-anchoring all index by point, and this is the only O(n) pass.
  const cum = useMemo(() => {
    const out = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      out[i] = out[i - 1]! + haversineMeters(points[i - 1]!, points[i]!);
    }
    return out;
  }, [points]);

  const startTrim = useCallback(() => {
    if (points.length < 3) {
      onToast('This trail is too short to trim');
      return;
    }
    onTrim({ start: 0, end: points.length - 1 });
  }, [points.length, onTrim, onToast]);

  const save = useCallback(
    async (mode: 'overwrite' | 'copy') => {
      if (trim === null || track === undefined) return;
      const sliced = sliceTrack(points, trim.start, trim.end);
      if (sliced.points.length < 2) {
        onToast('Trim leaves fewer than 2 points');
        return;
      }
      setBusy(true);
      try {
        const message = await lib.applyTrim(trackId, sliced.points, mode);
        onToast(message);
        onTrim(null);
      } catch {
        onToast('Trim failed: could not save');
      } finally {
        setBusy(false);
      }
    },
    [lib, onToast, onTrim, points, track, trackId, trim],
  );

  // Escape leaves trim mode, then the screen. Both are the "no harm" exit.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (trim !== null) onTrim(null);
      else onBack();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [trim, onTrim, onBack]);

  if (track === undefined) {
    return <div className="empty">This trail is no longer available.</div>;
  }

  const s = track.stats;
  const category = findCategory(track.category, lib.index.customCategories);
  const folder = lib.index.folders.find((f) => f.id === track.folderId);
  const timed = s.durationS > 0;
  const notes = orderNotes(track.notes ?? []);

  const keptM = trim === null ? s.distanceM : (cum[trim.end] ?? 0) - (cum[trim.start] ?? 0);
  const dropped =
    trim === null ? [] : retargetNotesAfterTrim(notes, points, trim.start, trim.end).dropped;

  const trimButton = (variant: 'icon' | 'wide') =>
    variant === 'icon' ? (
      <button
        type="button"
        className="row-action"
        aria-label="Trim trail"
        title="Trim trail"
        onClick={startTrim}
      >
        <IconScissors size={15} />
      </button>
    ) : (
      <button type="button" className="wide-action" onClick={startTrim}>
        <IconScissors size={14} />
        Trim trail
      </button>
    );

  const items: MenuItem[] = [
    { key: 'map', label: 'View on map', icon: <IconTarget size={14} />, onSelect: onLocate },
    { key: 'trim', label: 'Trim', icon: <IconScissors size={14} />, onSelect: startTrim },
    { key: 'cat', label: 'Set category', icon: <IconTag size={14} />, onSelect: () => onBack() },
    {
      key: 'del',
      label: 'Delete trail',
      icon: <IconTrash size={14} />,
      danger: true,
      divider: true,
      onSelect: () => {
        lib.removeTrack(trackId);
        onBack();
      },
    },
  ];

  return (
    <>
      <div className="focus-head">
        <button type="button" className="row-action" aria-label="Back to Library" onClick={onBack}>
          <IconBack size={16} />
        </button>
        <span className="focus-title-wrap">
          <span className="focus-title" title={track.name}>
            {track.name}
          </span>
          <span className="focus-sub">
            {category === null ? null : (
              <span className="focus-cat" style={{ color: category.color }}>
                <CategoryIcon icon={category.icon} size={12} />
                {category.name}
              </span>
            )}
            <span>{timed ? formatTimestamp(track.startedAt) : 'Planned route'}</span>
            {folder === undefined ? null : <span>{folder.name}</span>}
          </span>
        </span>
        {placement === 'title' ? trimButton('icon') : null}
        <button type="button" className="row-action" aria-label="More options" onClick={menu.open}>
          <IconDots size={14} />
        </button>
      </div>

      {menu.anchor === null ? null : (
        <Menu anchor={menu.anchor} items={items} onClose={menu.close} />
      )}

      <div className="tiles">
        <Tile label="Distance" value={formatDistance(s.distanceM)} />
        <Tile label="D+" value={formatElevation(s.ascentM)} tone="up" />
        <Tile label="D−" value={formatElevation(s.descentM)} tone="down" />
        {timed ? <Tile label="Duration" value={formatDuration(s.durationS)} /> : null}
        {timed ? <Tile label="Moving" value={formatDuration(s.movingTimeS)} /> : null}
        {timed ? <Tile label="Avg pace" value={formatPace(s.avgSpeedMps)} /> : null}
        {timed ? <Tile label="Max speed" value={formatSpeed(s.maxSpeedMps)} /> : null}
        <Tile
          label="Alt range"
          value={
            s.minAltitudeM === undefined || s.maxAltitudeM === undefined
              ? '—'
              : // One unit, on the pair — "264–548 m" fits a single column where
                // "264 m – 548 m" does not, and loses nothing.
                `${formatElevation(s.minAltitudeM).replace(/\s\D+$/, '')}–${formatElevation(s.maxAltitudeM)}`
          }
        />
        <Tile label="Points" value={s.pointCount.toLocaleString('en-CA')} />
      </div>

      {points.length === 0 ? (
        <div className="empty small">Loading points…</div>
      ) : (
        <ElevationProfile
          points={points}
          ascentM={s.ascentM}
          descentM={s.descentM}
          notes={notes}
          onScrub={onScrub}
          trim={
            trim === null
              ? null
              : { fromM: cum[trim.start] ?? 0, toM: cum[trim.end] ?? s.distanceM }
          }
        />
      )}

      {trim === null ? (
        <>
          {notes.length === 0 ? null : (
            <>
              <div className="micro section-label">Notes ({notes.length})</div>
              {notes.map((n, i) => (
                <div className="note-row" key={n.id}>
                  <span className="note-num num">{i + 1}</span>
                  <span className="note-body">
                    <span className="note-text">{n.text}</span>
                    <span className="note-at num">{formatDistance(n.distanceM)}</span>
                  </span>
                </div>
              ))}
            </>
          )}
          {placement === 'bottom' ? <div className="focus-foot">{trimButton('wide')}</div> : null}
        </>
      ) : (
        <div className="trim-body">
          <div className="micro section-label">Trim trail</div>
          <p className="dialog-text">
            Drag the handles to shorten the trail from either end. The highlighted segment is kept.
          </p>
          <TrimSlider
            count={points.length}
            start={trim.start}
            end={trim.end}
            onChange={(start, end) => onTrim({ start, end })}
          />
          <div className="trim-readout num">
            Keeping {formatDistance(keptM)} of {formatDistance(s.distanceM)} ·{' '}
            {(trim.end - trim.start + 1).toLocaleString('en-CA')} of{' '}
            {points.length.toLocaleString('en-CA')} points
            {dropped.length === 0 ? null : (
              <span className="warn"> · {dropped.length} note(s) would be dropped</span>
            )}
          </div>
          <div className="trim-actions">
            <button type="button" className="chip" onClick={() => onTrim(null)} disabled={busy}>
              Cancel
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => void save('copy')}
            >
              Save as copy
            </button>
            <button
              type="button"
              className="chip solid"
              disabled={busy}
              onClick={() => void save('overwrite')}
            >
              Overwrite
            </button>
          </div>
        </div>
      )}

      {/* The playground control, deliberately styled as a note rather than as
          product chrome — it is here to settle backlog item 6, not to ship. */}
      <div className="lab">
        <span className="micro">Trim button placement</span>
        <div className="seg inline">
          {TRIM_PLACEMENTS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={placement === p.key}
              onClick={() => onPlacement(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="tile">
      <span className="micro">{label}</span>
      <span className={`tile-value num${tone === undefined ? '' : ` ${tone}`}`}>{value}</span>
    </div>
  );
}
