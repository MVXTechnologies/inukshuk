import { useCallback, useMemo, useState } from 'react';

import { allCategories, findCategory } from '@core/library/categories';
import { countActiveFilters, filterTracks, type TrackFilter } from '@core/library/filterTracks';
import { folderItemCount, groupByFolder } from '@core/library/folders';
import { UNGROUPED_FOLDER_ID } from '@core/library/visibility';
import { sortWaypointsNewestFirst } from '@core/library/waypoints';
import type { Folder, Waypoint } from '@core/models';

import { CategoryIcon } from '@/ui/CategoryIcon';
import { Dialog } from '@/ui/Dialog';
import {
  IconCheck,
  IconChevron,
  IconEye,
  IconFilter,
  IconFolder,
  IconPencil,
  IconPlus,
  IconSort,
  IconTrash,
} from '@/ui/Icons';
import { Menu, useMenuAnchor } from '@/ui/Menu';

import { FilterSheet } from './FilterSheet';
import { isSortKey, SORTS, sortTracks, type SortKey } from './sortTracks';
import { TrackCard } from './TrackCard';
import type { LibraryState } from './useLibrary';
import type { WebTrack } from './types';
import { WaypointCard } from './WaypointCard';

/** Which item a drag is carrying. Folder headers are the only drop targets. */
interface Dragging {
  kind: 'track' | 'waypoint';
  id: string;
}

/**
 * The Library screen.
 *
 * Grouping, filtering, waypoint ordering and folder-visibility semantics are
 * all `@core/library/*` calls — `groupByFolder`, `folderItemCount`,
 * `filterTracks`, `countActiveFilters`, `sortWaypointsNewestFirst`,
 * `UNGROUPED_FOLDER_ID`, and (in `useLibrary`) `nextFolderVisibility`. The
 * component's own job is layout, collapse state, drag state and menus.
 *
 * Two structural rules copied from `LibraryScreen.tsx` that are easy to get
 * wrong and matter for what the screen looks like:
 *  - a folder group is rendered even when it is empty, and its title drops the
 *    count entirely at zero (`TripA`, never `TripA (0)`);
 *  - waypoints only get their own flat section when NO folders exist; the
 *    moment there is one folder they move inside the groups, after that
 *    folder's trails, newest first.
 */
export function LibraryPanel({
  lib,
  filter,
  onFilter,
  sort,
  onSort,
  onOpenTrail,
  onLocateTrack,
  onLocateWaypoint,
}: {
  lib: LibraryState;
  filter: TrackFilter;
  onFilter: (f: TrackFilter) => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  onOpenTrail: (id: string) => void;
  onLocateTrack: (track: WebTrack) => void;
  onLocateWaypoint: (waypoint: Waypoint) => void;
}) {
  const { index } = lib;
  const [showFilters, setShowFilters] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Folder | null>(null);
  const [creating, setCreating] = useState(false);
  const [categoryFor, setCategoryFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => void } | null>(
    null,
  );
  const sortMenu = useMenuAnchor();

  const activeFilters = countActiveFilters(filter);

  /**
   * `filterTracks` and `groupByFolder` are typed ON `TrackSummary` rather than
   * generic OVER it, so anything they touch comes back widened and a
   * `WebTrack`'s extras (`preview`, `color`) are gone. Every trail is therefore
   * resolved back through this map after a `@core` pass — no cast, and the card
   * always gets the same object identity. (`sortTracks`, written here, IS
   * generic; making the two `@core` helpers generic would remove this map
   * entirely and is worth doing.)
   */
  const byId = useMemo(() => new Map(index.tracks.map((t) => [t.id, t])), [index.tracks]);
  const widen = useCallback((summary: { id: string }) => byId.get(summary.id), [byId]);

  // Filter, then sort. Both operate on the whole list before grouping, so a
  // folder's count is the count of what the folder actually shows — the same
  // order of operations the app uses (it just has no sort step).
  const visibleTracks = useMemo(() => {
    const kept = filterTracks(index.tracks, filter).flatMap((t) => {
      const web = byId.get(t.id);
      return web === undefined ? [] : [web];
    });
    return sortTracks(kept, sort);
  }, [index.tracks, filter, sort, byId]);

  const grouping = useMemo(
    () => groupByFolder(index.folders, [], visibleTracks, index.waypoints),
    [index.folders, visibleTracks, index.waypoints],
  );

  const toggle = useCallback(
    (key: string) => setCollapsed((prev) => ({ ...prev, [key]: prev[key] !== true })),
    [],
  );

  const drop = useCallback(
    (folderId: string | null) => {
      if (dragging === null) return;
      lib.setItemFolder(dragging.kind, dragging.id, folderId);
      setDragging(null);
      setHovered(null);
    },
    [dragging, lib],
  );

  const hasFolders = index.folders.length > 0;

  /** Render one grouped/ungrouped trail, re-widened through `byId`. */
  const cardById = (summary: { id: string }) => {
    const track = widen(summary);
    return track === undefined ? null : cardFor(track);
  };

  const cardFor = (track: WebTrack) => (
    <TrackCard
      key={track.id}
      track={track}
      folders={index.folders}
      customCategories={index.customCategories}
      selected={false}
      dragging={dragging?.id === track.id}
      onOpen={() => onOpenTrail(track.id)}
      onLocate={() => onLocateTrack(track)}
      onSetFolder={(f) => lib.setItemFolder('track', track.id, f)}
      onCategory={() => setCategoryFor(track.id)}
      onTrim={() => onOpenTrail(`${track.id}!trim`)}
      onRemove={() =>
        setConfirm({
          title: 'Delete trail',
          body: `Delete trail "${track.name}"? Its GPX, notes and stats are permanently removed.`,
          run: () => lib.removeTrack(track.id),
        })
      }
      onDragStart={() => setDragging({ kind: 'track', id: track.id })}
      onDragEnd={() => {
        setDragging(null);
        setHovered(null);
      }}
    />
  );

  const cardForWaypoint = (waypoint: Waypoint) => (
    <WaypointCard
      key={waypoint.id}
      waypoint={waypoint}
      folders={index.folders}
      dragging={dragging?.id === waypoint.id}
      onLocate={() => onLocateWaypoint(waypoint)}
      onSetFolder={(f) => lib.setItemFolder('waypoint', waypoint.id, f)}
      onRemove={() =>
        setConfirm({
          title: 'Delete waypoint',
          body: `Delete waypoint "${waypoint.label}"? Its note is permanently removed.`,
          run: () => lib.removeWaypoint(waypoint.id),
        })
      }
      onDragStart={() => setDragging({ kind: 'waypoint', id: waypoint.id })}
      onDragEnd={() => {
        setDragging(null);
        setHovered(null);
      }}
    />
  );

  // ------------------------------------------------------------- header ----
  return (
    <>
      <div className="lib-toolbar">
        <button
          type="button"
          className="tool"
          aria-label="Sort trails"
          title="Sort"
          onClick={sortMenu.open}
        >
          <IconSort size={14} />
          {SORTS.find((s) => s.key === sort)?.label ?? 'Newest'}
        </button>

        <button
          type="button"
          className="tool"
          aria-pressed={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          <IconFilter size={13} />
          Filter
          {activeFilters > 0 ? <span className="badge num">{activeFilters}</span> : null}
        </button>

        <span className="spacer" />

        <button
          type="button"
          className="tool"
          onClick={() => setCreating(true)}
          title="New folder"
          aria-label="New folder"
        >
          <IconPlus size={13} />
          <IconFolder size={14} />
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
            onSelect: () => {
              if (isSortKey(s.key)) onSort(s.key);
            },
          }))}
        />
      )}

      {showFilters ? (
        <FilterSheet customCategories={index.customCategories} onChange={onFilter} />
      ) : null}

      {/* Folder visibility — the map's content picker, brought onto this screen
          because that is where the folders are. `nextFolderVisibility` decides
          what a tap means (see useLibrary.showFolder); the rule it encodes is
          that the picker must never leave 'folders' mode with an empty
          selection, which is a real bug fix and not re-derived here. */}
      {hasFolders ? (
        <>
          <div className="micro section-label">
            <IconEye size={11} /> Show on the map
          </div>
          <div className="chips">
            <button
              type="button"
              className="chip"
              aria-pressed={index.mapVisibilityMode === 'type'}
              onClick={lib.showEverything}
            >
              Everything
            </button>
            {index.folders.map((f) => (
              <button
                key={f.id}
                type="button"
                className="chip"
                aria-pressed={
                  index.mapVisibilityMode === 'folders' && index.visibleFolderIds.includes(f.id)
                }
                onClick={() => lib.showFolder(f.id)}
              >
                {f.name}
              </button>
            ))}
            <button
              type="button"
              className="chip"
              aria-pressed={
                index.mapVisibilityMode === 'folders' &&
                index.visibleFolderIds.includes(UNGROUPED_FOLDER_ID)
              }
              onClick={() => lib.showFolder(UNGROUPED_FOLDER_ID)}
            >
              Ungrouped
            </button>
          </div>
        </>
      ) : null}

      {/* ------------------------------------------------------- sections -- */}
      {hasFolders ? (
        <>
          {grouping.groups.map((group) => {
            const key = `folder:${group.folder.id}`;
            const open = collapsed[key] !== true;
            const count = folderItemCount(group);
            return (
              <section key={key}>
                <SectionHead
                  title={count === 0 ? group.folder.name : `${group.folder.name} (${count})`}
                  open={open}
                  hovered={hovered === group.folder.id}
                  onToggle={() => toggle(key)}
                  onDragOver={() => setHovered(group.folder.id)}
                  onDragLeave={() => setHovered((h) => (h === group.folder.id ? null : h))}
                  onDrop={() => drop(group.folder.id)}
                  actions={
                    <>
                      <button
                        type="button"
                        className="row-action"
                        aria-label={`Rename ${group.folder.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming(group.folder);
                        }}
                      >
                        <IconPencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="row-action danger"
                        aria-label={`Delete ${group.folder.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirm({
                            title: 'Delete folder',
                            body: `Delete folder "${group.folder.name}"? Its items fall back to Ungrouped.`,
                            run: () => lib.removeFolder(group.folder.id),
                          });
                        }}
                      >
                        <IconTrash size={13} />
                      </button>
                    </>
                  }
                />
                {open ? (
                  count === 0 ? (
                    <div className="empty small">
                      Empty folder.
                      <br />
                      Drag a trail or waypoint onto this header.
                    </div>
                  ) : (
                    <>
                      {group.tracks.map(cardById)}
                      {sortWaypointsNewestFirst(group.waypoints).map(cardForWaypoint)}
                    </>
                  )
                ) : null}
              </section>
            );
          })}

          {grouping.ungroupedTracks.length + grouping.ungroupedWaypoints.length > 0 ? (
            <section>
              <SectionHead
                title={`Ungrouped (${grouping.ungroupedTracks.length + grouping.ungroupedWaypoints.length})`}
                open={collapsed['ungrouped'] !== true}
                hovered={hovered === UNGROUPED_FOLDER_ID}
                onToggle={() => toggle('ungrouped')}
                onDragOver={() => setHovered(UNGROUPED_FOLDER_ID)}
                onDragLeave={() => setHovered((h) => (h === UNGROUPED_FOLDER_ID ? null : h))}
                onDrop={() => drop(null)}
              />
              {collapsed['ungrouped'] !== true ? (
                <>
                  {grouping.ungroupedTracks.map(cardById)}
                  {sortWaypointsNewestFirst(grouping.ungroupedWaypoints).map(cardForWaypoint)}
                </>
              ) : null}
            </section>
          ) : null}
        </>
      ) : (
        <>
          <section>
            <SectionHead
              title={
                activeFilters > 0
                  ? `Recorded trails (${visibleTracks.length}/${index.tracks.length})`
                  : `Recorded trails (${index.tracks.length})`
              }
              open={collapsed['trails'] !== true}
              onToggle={() => toggle('trails')}
            />
            {collapsed['trails'] !== true ? (
              visibleTracks.length === 0 ? (
                <div className="empty">
                  {index.tracks.length === 0 ? 'No trails yet.' : 'No trails match the filters.'}
                  <br />
                  {index.tracks.length === 0
                    ? 'Drag a GPX file onto the window.'
                    : 'Adjust or clear the filters above.'}
                </div>
              ) : (
                visibleTracks.map(cardFor)
              )
            ) : null}
          </section>

          {index.waypoints.length > 0 ? (
            <section>
              <SectionHead
                title={`Waypoints (${index.waypoints.length})`}
                open={collapsed['waypoints'] !== true}
                onToggle={() => toggle('waypoints')}
              />
              {collapsed['waypoints'] !== true
                ? sortWaypointsNewestFirst(index.waypoints).map(cardForWaypoint)
                : null}
            </section>
          ) : null}
        </>
      )}

      {/* --------------------------------------------------------- dialogs -- */}
      {categoryFor === null ? null : (
        <Dialog title="Set category" onClose={() => setCategoryFor(null)}>
          <button
            type="button"
            className="pick"
            onClick={() => {
              lib.setTrackCategory(categoryFor, null);
              setCategoryFor(null);
            }}
          >
            <span className="pick-icon" />
            <span className="pick-label">None</span>
            {index.tracks.find((t) => t.id === categoryFor)?.category === undefined ? (
              <IconCheck size={13} />
            ) : null}
          </button>
          {allCategories(index.customCategories).map((c) => {
            const current =
              findCategory(
                index.tracks.find((t) => t.id === categoryFor)?.category,
                index.customCategories,
              )?.id === c.id;
            return (
              <button
                key={c.id}
                type="button"
                className="pick"
                onClick={() => {
                  lib.setTrackCategory(categoryFor, c.id);
                  setCategoryFor(null);
                }}
              >
                <span className="pick-icon" style={{ color: c.color }}>
                  <CategoryIcon icon={c.icon} size={17} />
                </span>
                <span className="pick-label">{c.name}</span>
                {current ? <IconCheck size={13} /> : null}
              </button>
            );
          })}
        </Dialog>
      )}

      {creating || renaming !== null ? (
        <NameDialog
          title={renaming === null ? 'New folder' : 'Rename folder'}
          confirm={renaming === null ? 'Create' : 'Rename'}
          initial={renaming?.name ?? ''}
          onClose={() => {
            setCreating(false);
            setRenaming(null);
          }}
          onSubmit={(name) => {
            if (renaming === null) lib.addFolder(name);
            else lib.renameFolder(renaming.id, name);
            setCreating(false);
            setRenaming(null);
          }}
        />
      ) : null}

      {confirm === null ? null : (
        <Dialog
          title={confirm.title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="chip" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="chip solid danger"
                onClick={() => {
                  confirm.run();
                  setConfirm(null);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p className="dialog-text">{confirm.body}</p>
        </Dialog>
      )}
    </>
  );
}

function SectionHead({
  title,
  open,
  hovered,
  actions,
  onToggle,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  title: string;
  open: boolean;
  hovered?: boolean;
  actions?: React.ReactNode;
  onToggle: () => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
}) {
  return (
    <div
      className={`sec-head${hovered === true ? ' drop' : ''}`}
      onDragOver={
        onDragOver === undefined
          ? undefined
          : (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              onDragOver();
            }
      }
      onDragLeave={onDragLeave}
      onDrop={
        onDrop === undefined
          ? undefined
          : (e) => {
              e.preventDefault();
              onDrop();
            }
      }
    >
      <button type="button" className="sec-toggle" onClick={onToggle} aria-expanded={open}>
        <IconChevron size={14} open={open} />
        <span className="sec-title">{title}</span>
      </button>
      {actions === undefined ? null : <span className="sec-actions">{actions}</span>}
    </div>
  );
}

function NameDialog({
  title,
  confirm,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  confirm: string;
  initial: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="chip" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="chip solid" onClick={() => onSubmit(value)}>
            {confirm}
          </button>
        </>
      }
    >
      {/* A name dialog with exactly one field exists to be typed into, so it
          takes focus on open. */}
      <input
        className="field wide"
        autoFocus
        placeholder="Folder name"
        aria-label="Folder name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit(value);
        }}
      />
    </Dialog>
  );
}
