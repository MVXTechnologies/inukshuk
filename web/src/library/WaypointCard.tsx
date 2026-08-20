import { notePreview } from '@core/library/waypoints';
import type { Folder, Waypoint } from '@core/models';
import { formatTimestamp } from '@lib/format';

import { IconDots, IconGrip, IconPin, IconTrash } from '@/ui/Icons';
import { Menu, useMenuAnchor, type MenuItem } from '@/ui/Menu';

/**
 * One waypoint row. Same anatomy as the app's: pin glyph, label, the one-line
 * `notePreview` (omitted entirely when there is no note — `notePreview` returns
 * null for blank, and the row must not reserve an empty line for it), then the
 * timestamp. The 80-character truncation is `@core`'s, not a CSS ellipsis, so
 * the cut lands in the same place it does on the phone.
 */
export function WaypointCard({
  waypoint,
  folders,
  dragging,
  onLocate,
  onSetFolder,
  onRemove,
  onDragStart,
  onDragEnd,
}: {
  waypoint: Waypoint;
  folders: readonly Folder[];
  dragging: boolean;
  onLocate: () => void;
  onSetFolder: (folderId: string | null) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const menu = useMenuAnchor();
  const preview = notePreview(waypoint.note);

  const items: MenuItem[] = [
    { key: 'map', label: 'Show on map', icon: <IconPin size={14} />, onSelect: onLocate },
    ...(folders.length === 0
      ? []
      : [
          { key: 'cap', label: 'Move to folder', caption: true, divider: true } as MenuItem,
          ...folders.map((f): MenuItem => ({
            key: `f-${f.id}`,
            label: f.name,
            checked: waypoint.folderId === f.id,
            onSelect: () => onSetFolder(waypoint.folderId === f.id ? null : f.id),
          })),
          ...(waypoint.folderId === undefined
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
      label: 'Delete waypoint',
      icon: <IconTrash size={14} />,
      danger: true,
      divider: true,
      onSelect: onRemove,
    },
  ];

  return (
    <div
      className={`card wpt${dragging ? ' dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', waypoint.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <span className="card-grip" aria-hidden>
        <IconGrip size={15} />
      </span>

      <button type="button" className="card-main" onClick={onLocate}>
        <span className="card-icon wpt-icon">
          <IconPin size={17} />
        </span>
        <span className="card-text">
          <span className="card-title" title={waypoint.label}>
            {waypoint.label}
          </span>
          {preview === null ? null : <span className="card-note">{preview}</span>}
          <span className="card-sub">{formatTimestamp(waypoint.createdAt)}</span>
        </span>
      </button>

      <button
        type="button"
        className="row-action"
        aria-label={`Waypoint options for ${waypoint.label}`}
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
