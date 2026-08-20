import { findCategory, type CustomCategory } from '@core/library/categories';
import type { Folder } from '@core/models';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatTimestamp,
} from '@lib/format';

import { CategoryIcon } from '@/ui/CategoryIcon';
import { IconDots, IconGrip, IconScissors, IconTag, IconTrash } from '@/ui/Icons';
import { Menu, useMenuAnchor, type MenuItem } from '@/ui/Menu';

import type { WebTrack } from './types';

/**
 * One trail card.
 *
 * The anatomy is the app's, field for field and in the app's order — name,
 * `formatTimestamp`, then the ' · '-joined stats line, with a 4 px left border
 * in the category colour and the category glyph as the leading icon. Duration
 * and pace drop out entirely when `durationS === 0`, which is what makes the
 * untimed "navigation trail" cards read as plans rather than as recordings that
 * took no time.
 *
 * Two things are NOT the app's, both on purpose:
 *  - the stats line is a grid of labelled cells rather than one run-on string.
 *    On a 14 px phone row the app's `12.34 km · 1:04:09 · 5:12/km · ↑842 m ·
 *    ↓810 m` is a wall of numbers with no anchor for the eye; here the same
 *    five values keep the same order and formatters but get a column each, so
 *    the whole list can be scanned down a column. That is a decision to accept
 *    or reject, and seeing both is the point of the playground.
 *  - drag-to-folder is HTML5 drag-and-drop rather than a PanResponder.
 */
export function TrackCard({
  track,
  folders,
  customCategories,
  selected,
  dragging,
  onOpen,
  onLocate,
  onSetFolder,
  onCategory,
  onTrim,
  onRemove,
  onDragStart,
  onDragEnd,
}: {
  track: WebTrack;
  folders: readonly Folder[];
  customCategories: readonly CustomCategory[];
  selected: boolean;
  dragging: boolean;
  onOpen: () => void;
  onLocate: () => void;
  onSetFolder: (folderId: string | null) => void;
  onCategory: () => void;
  onTrim: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const menu = useMenuAnchor();
  const category = findCategory(track.category, customCategories);
  const s = track.stats;
  const timed = s.durationS > 0;

  const items: MenuItem[] = [
    { key: 'map', label: 'View on map', icon: <IconDots size={14} />, onSelect: onLocate },
    { key: 'cat', label: 'Set category', icon: <IconTag size={14} />, onSelect: onCategory },
    { key: 'trim', label: 'Trim', icon: <IconScissors size={14} />, onSelect: onTrim },
    ...(folders.length === 0
      ? []
      : [
          { key: 'cap', label: 'Move to folder', caption: true, divider: true } as MenuItem,
          ...folders.map((f): MenuItem => ({
            key: `f-${f.id}`,
            label: f.name,
            checked: track.folderId === f.id,
            onSelect: () => onSetFolder(track.folderId === f.id ? null : f.id),
          })),
          ...(track.folderId === undefined
            ? []
            : [
                {
                  key: 'unfolder',
                  label: 'Remove from folder',
                  onSelect: () => onSetFolder(null),
                } as MenuItem,
              ]),
        ]),
    {
      key: 'del',
      label: 'Delete trail',
      icon: <IconTrash size={14} />,
      danger: true,
      divider: true,
      onSelect: onRemove,
    },
  ];

  return (
    <div
      className={`card${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      style={category === null ? undefined : { borderLeftColor: category.color }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without payload on the transfer.
        e.dataTransfer.setData('text/plain', track.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <span className="card-grip" aria-hidden>
        <IconGrip size={15} />
      </span>

      <button type="button" className="card-main" onClick={onOpen}>
        <span
          className="card-icon"
          style={category === null ? undefined : { color: category.color }}
        >
          {category === null ? (
            <span className="card-icon-blank" aria-hidden />
          ) : (
            <CategoryIcon icon={category.icon} size={19} />
          )}
        </span>

        <span className="card-text">
          <span className="card-title" title={track.name}>
            {track.name}
          </span>
          <span className="card-sub">
            {timed ? formatTimestamp(track.startedAt) : 'Planned route · no timing'}
            {category === null ? null : <span className="card-cat">{category.name}</span>}
          </span>

          <span className="card-stats num">
            <Stat label="Dist" value={formatDistance(s.distanceM)} />
            {timed ? <Stat label="Time" value={formatDuration(s.durationS)} /> : null}
            {timed ? <Stat label="Pace" value={formatPace(s.avgSpeedMps)} /> : null}
            <Stat label="D+" value={formatElevation(s.ascentM)} up />
            <Stat label="D−" value={formatElevation(s.descentM)} down />
          </span>
        </span>
      </button>

      <button
        type="button"
        className="row-action"
        aria-label={`More options for ${track.name}`}
        onClick={menu.open}
      >
        <IconDots size={14} />
      </button>

      {menu.anchor === null ? null : (
        <Menu anchor={menu.anchor} items={items} onClose={menu.close} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  up,
  down,
}: {
  label: string;
  value: string;
  up?: boolean;
  down?: boolean;
}) {
  return (
    <span className={`stat${up === true ? ' up' : ''}${down === true ? ' down' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </span>
  );
}
