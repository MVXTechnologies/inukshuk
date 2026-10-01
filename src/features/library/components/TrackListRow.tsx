import { findCategory, type CustomCategory } from '@core/library/categories';
import { shortDate, trailCaption, trailStatsLine } from '@core/library/libraryRows';
import { sourceLabel } from '@core/import/origin';
import type { Folder, TrackPoint, TrackSummary } from '@core/models';
import type { Units } from '@core/format';
import { target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Divider, Icon, IconButton, Menu } from 'react-native-paper';

import { ElevationProfile } from '../../common/components/ElevationProfile';
import type { DragItem } from '../useDragToFolder';
import { RowDivider, TrailRow } from './LibraryRows';
import { MoveToFolderItems } from './MoveToFolderItems';

/**
 * Everything a trail row can ask the Library for. The screen passes ONE
 * object with a stable identity (each entry forwards to its latest handler),
 * so a memoized row re-renders only when its own data changes — not on every
 * menu open, selection tap or drag hover elsewhere in a 2,000-trail list.
 */
export interface TrackRowActions {
  press: (t: TrackSummary) => void;
  longPress: (t: TrackSummary) => void;
  openMenu: (t: TrackSummary) => void;
  closeMenu: () => void;
  rename: (t: TrackSummary) => void;
  viewOnMap: (t: TrackSummary) => void;
  toggleElevation: (t: TrackSummary) => void;
  share: (t: TrackSummary) => void;
  sendToStrava: (t: TrackSummary) => void;
  trim: (t: TrackSummary) => void;
  /** Reopen a route drawn on the map in the drawing tool (#502). */
  editRoute: (t: TrackSummary) => void;
  merge: (t: TrackSummary) => void;
  setCategory: (t: TrackSummary) => void;
  moveToFolder: (t: TrackSummary, folderId: string | null) => void;
  remove: (t: TrackSummary) => void;
  dragHandleProps: (item: DragItem) => object;
}

export interface TrackListRowProps {
  track: TrackSummary;
  /** Hairline above the row (it follows another row of its section). */
  divider: boolean;
  customCategories: readonly CustomCategory[];
  night: boolean;
  units: Units;
  /** "Now" for the row dates. */
  nowMs: number;
  selecting: boolean;
  selected: boolean;
  menuOpen: boolean;
  /** Elevation peek: undefined = closed, null = loading, else the points. */
  elevation: TrackPoint[] | null | undefined;
  /** Organize mode with folders: show the drag grip. */
  grip: boolean;
  stravaConnected: boolean;
  folders: readonly Folder[];
  actions: TrackRowActions;
}

/**
 * One trail in the Library list (#494): the row, its ⋮ menu and its inline
 * elevation peek. Memoized — see {@link TrackRowActions}.
 */
export const TrackListRow = memo(function TrackListRow({
  track: t,
  divider,
  customCategories,
  night,
  units,
  nowMs,
  selecting,
  selected,
  menuOpen,
  elevation,
  grip,
  stravaConnected,
  folders,
  actions,
}: TrackListRowProps) {
  const tokens = useSchemeTokens();
  // Decision 7: the type is a badge on the thumbnail, a word in the caption
  // and part of the spoken label — never colour alone.
  const found = findCategory(t.category, customCategories);
  // Night red (decision 4) allows no other hue: the badge takes the ink red.
  const category = found && night ? { ...found, color: tokens.ink } : found;
  const stats = trailStatsLine(t.stats, units);
  // A route drawn on the map says so (#502): it is a plan, not an outing.
  const typeName = t.plan
    ? ['Planned route', category && category.id !== 'navigation' ? category.name : null]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : (category?.name ?? null);
  const caption = trailCaption(t.startedAt, typeName, nowMs);
  const spoken = [
    t.name,
    typeName ?? undefined,
    shortDate(t.startedAt, nowMs),
    stats,
    t.origin ? `from ${sourceLabel(t.origin.source)}` : undefined,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(', ');

  // Full overflow menu: every secondary action plus folder membership — the
  // row itself only opens the trail (revamp §5).
  const run = (action: (t: TrackSummary) => void) => () => {
    actions.closeMenu();
    action(t);
  };
  const menu = (
    <Menu
      visible={menuOpen}
      onDismiss={actions.closeMenu}
      anchor={
        <IconButton
          icon="dots-vertical"
          size={22}
          iconColor={tokens.inkMuted}
          style={styles.menuButton}
          onPress={() => actions.openMenu(t)}
          accessibilityLabel="More options"
        />
      }
    >
      <Menu.Item leadingIcon="pencil-outline" title="Rename" onPress={run(actions.rename)} />
      <Menu.Item leadingIcon="map-outline" title="View on map" onPress={run(actions.viewOnMap)} />
      {/* The row's old chart button: an inline profile peek under the row. */}
      <Menu.Item
        leadingIcon="chart-areaspline"
        title={elevation !== undefined ? 'Hide elevation profile' : 'Elevation profile'}
        accessibilityLabel="Elevation profile"
        onPress={run(actions.toggleElevation)}
      />
      <Menu.Item leadingIcon="share-variant" title="Share GPX" onPress={run(actions.share)} />
      {stravaConnected && (
        <Menu.Item
          leadingIcon="cloud-upload-outline"
          title="Send to Strava"
          onPress={run(actions.sendToStrava)}
        />
      )}
      {t.plan !== undefined && (
        <Menu.Item
          leadingIcon="vector-polyline-edit"
          title="Edit route"
          onPress={run(actions.editRoute)}
        />
      )}
      <Menu.Item leadingIcon="content-cut" title="Trim" onPress={run(actions.trim)} />
      {/* Enters the multi-select mode (the one long-press opens) with this
          trail pre-selected; the user then taps the others and confirms. */}
      <Menu.Item leadingIcon="call-merge" title="Merge" onPress={run(actions.merge)} />
      <Menu.Item
        leadingIcon="tag-outline"
        title="Set category"
        onPress={run(actions.setCategory)}
      />
      <MoveToFolderItems
        folders={folders}
        folderId={t.folderId}
        onMove={(folderId) => actions.moveToFolder(t, folderId)}
      />
      <Divider />
      <Menu.Item
        leadingIcon="trash-can-outline"
        title="Delete trail"
        onPress={run(actions.remove)}
      />
    </Menu>
  );

  return (
    <>
      {divider && <RowDivider />}
      <TrailRow
        track={t}
        category={category}
        stats={stats}
        caption={caption}
        // Long-press enters trail selection (for merging); while selecting,
        // taps toggle membership instead of opening the trail.
        accessibilityLabel={
          selecting
            ? `${t.name} — ${selected ? 'deselect' : 'select'} for merge`
            : `${spoken} — open trail view, long-press to select`
        }
        onPress={() => actions.press(t)}
        onLongPress={() => actions.longPress(t)}
        selecting={selecting}
        selected={selected}
        sourceMark={t.origin ? sourceLabel(t.origin.source) : undefined}
        leading={
          grip ? (
            <View
              style={styles.dragHandle}
              {...actions.dragHandleProps({ kind: 'track', id: t.id, label: t.name })}
              accessibilityLabel={`Drag ${t.name} to a folder`}
            >
              <Icon source="drag-vertical" size={22} color={tokens.inkMuted} />
            </View>
          ) : null
        }
        trailing={menu}
      >
        {elevation !== undefined &&
          (elevation ? (
            <ElevationProfile
              points={elevation}
              ascentM={t.stats.ascentM}
              descentM={t.stats.descentM}
            />
          ) : (
            <ActivityIndicator style={styles.loader} />
          ))}
      </TrailRow>
    </>
  );
});

const styles = StyleSheet.create({
  menuButton: { margin: 0, width: 44, height: target.min },
  dragHandle: {
    width: 36,
    height: target.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loader: { paddingVertical: 24 },
});
