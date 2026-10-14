/**
 * Team mode's chrome on the map (#589, #707, #708): in signal mode the
 * SOS-only button (bottom right; the team's other actions live in the bar's
 * panel), the sender's undo snackbar, the team panel dropped from the bar,
 * the active SOS / gather band in the strip area while the bar is away, and
 * the compact cards; a tapped teammate's card (`TeammateCard`) or shared
 * waypoint; pins and the pin composer. A plain themed View
 * for the card (paper-surface-ios-flex-collapse); its own state store so
 * MapScreen only routes the tap.
 */
import { rangeAndBearing } from '@core/teamui/positions';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { MAP_OVERLAY_Z } from '@features/map/overlayOrder';
import { formatDistance } from '@state/formatters';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text } from 'react-native-paper';
import { create } from 'zustand';

import { AlertBands } from '../bar/AlertBands';
import { SosButton } from '../bar/SosButton';
import { TeamPanel } from '../bar/TeamPanel';
import { UndoSnack } from '../bar/UndoSnack';
import { usePendingAlert } from '../bar/pendingAlert';
import { TEAM_TAP_LAYERS } from './layerIds';
import { TeamSheetCard } from './TeamCards';
import { TeammateCard } from './TeammateCard';
import { useTeamSheet, useTeamSignalMode } from './teamMode';
import { usePhotoCard } from '@features/photos/PhotoBottomCard';
import { TrailEditBar, useTrailEdit } from './TrailEditor';
import { KeyboardLifted } from '@ui/components/KeyboardLifted';
import { TeamPinCard } from './TeamPinCard';
import { useTeamPick } from './TeamPick';
import { TeamPinComposer, usePinDraft } from './TeamPinComposer';
import { DrawAlertSnack } from '../draw/DrawAlertSnack';
import { TeamShapeCard } from '../draw/ShapeCard';
import { useTeamDrawStore } from '@state/teamDrawStore';

export type TeamMapHit =
  | { kind: 'member'; id: string }
  | { kind: 'waypoint'; id: string }
  | { kind: 'pin'; owner: string; id: string };

export const useTeamMapSelection = create<{
  hit: TeamMapHit | null;
  select: (hit: TeamMapHit | null) => void;
}>((set) => ({ hit: null, select: (hit) => set({ hit }) }));

/** A finger's width around the tap, px. */
const HIT_PX = 16;

/** What a map tap hits among the team layers (MapScreen's tap routing), or null. */
export async function hitTestTeam(
  map: {
    queryRenderedFeatures: (
      box: [[number, number], [number, number]],
      options: { layers: string[] },
    ) => Promise<unknown[]>;
  },
  px: number,
  py: number,
): Promise<TeamMapHit | null> {
  try {
    const found = await map.queryRenderedFeatures(
      [
        [px - HIT_PX, py - HIT_PX],
        [px + HIT_PX, py + HIT_PX],
      ],
      { layers: TEAM_TAP_LAYERS },
    );
    for (const f of found) {
      const feat = f as { layer?: { id?: string }; properties?: Record<string, unknown> };
      const p = feat.properties ?? {};
      if (typeof p['member'] === 'string') return { kind: 'member', id: p['member'] };
      if (typeof p['waypoint'] === 'string') return { kind: 'waypoint', id: p['waypoint'] };
    }
  } catch {
    // Layers absent (team off) or the map mid-teardown: not a team tap.
  }
  return null;
}

const dist = (m: number) => formatDistance(m, { style: 'short' });

export function TeamMapOverlay({
  here,
  cardStyle,
  cardSlotFree,
  fabBottom,
  panelTop,
  snackStyle,
  bandInStrip = false,
  onNavigate,
  onPointActions,
  screenFocused = true,
}: {
  /** My position, for distance and bearing. */
  here: { latitude: number; longitude: number } | null;
  cardStyle: StyleProp<ViewStyle>;
  cardSlotFree: boolean;
  /** Where the SOS button sits (above the bottom chrome). */
  fabBottom: number;
  /** Where the team panel drops from (the top of the team bar). */
  panelTop: number;
  /** Where the undo snackbar docks (the map's snackbar lane). */
  snackStyle: StyleProp<ViewStyle>;
  /**
   * The bar's column is not on screen (the top slot is busy): the active
   * SOS / gather band shows in the strip area instead (#708).
   */
  bandInStrip?: boolean;
  onNavigate: (latitude: number, longitude: number) => void;
  /** Long-press menu's secondary row: Navigate here / Coordinates / Convert. */
  onPointActions: (at: [number, number], what: 'navigate' | 'coordinates' | 'convert') => void;
  /** Whether the map screen is focused (`useIsFocused()`): cards answer Back only then. */
  screenFocused?: boolean;
}) {
  const t = useSchemeTokens();
  const { installedAt, show } = useExtensionPrefs('team');
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const shares = useTeamStore((s) => s.shares);
  const pins = useTeamStore((s) => s.pins);
  const draft = usePinDraft((s) => s.at);
  const hit = useTeamMapSelection((s) => s.hit);
  const select = useTeamMapSelection((s) => s.select);
  const sheet = useTeamSheet((s) => s.sheet);
  const signal = useTeamSignalMode();
  const photoCard = usePhotoCard((s) => s.target);
  const picking = useTeamPick((s) => s.purpose !== null);
  const editing = useTrailEdit((s) => s.trail !== null);
  const pending = usePendingAlert((s) => s.pending !== null);
  // Team drawing (#683): its mode owns the screen; a shape's card is a card.
  const drawing = useTeamDrawStore((s) => s.active);
  const shapeCard = useTeamDrawStore((s) => s.card !== null);
  if (installedAt === 0 || !show || view === null) return null;

  const member = hit?.kind === 'member' ? positions.find((p) => p.id === hit.id) : undefined;
  const row = member ? view.members.find((m) => m.id === member.id) : undefined;
  const wpt = hit?.kind === 'waypoint' ? shares.waypoints.find((w) => w.id === hit.id) : undefined;
  // #676 — a shared pin is not one of mine: its card says whose share it is
  // instead of offering Move (the team record has its own edit rules).
  const sharer = wpt?.by ? view.members.find((m) => m.id === wpt.by) : undefined;
  const target = wpt ? { lat: wpt.lat, lon: wpt.lon } : null;
  const rb = target && here ? rangeAndBearing(here, target) : null;
  const pin =
    hit?.kind === 'pin' ? pins.find((p) => p.owner === hit.owner && p.id === hit.id) : undefined;
  const panel = sheet?.kind === 'menu';
  const card = sheet !== null && !panel;
  // The SOS button and the strip band never cover a card: any card, sheet
  // or popup hides them.
  const chromeFree =
    signal &&
    !picking &&
    !editing &&
    !drawing &&
    !shapeCard &&
    cardSlotFree &&
    draft === null &&
    hit === null &&
    photoCard === null &&
    !card;

  return (
    <>
      {editing && (
        <KeyboardLifted style={cardStyle}>
          <TrailEditBar style={{}} />
        </KeyboardLifted>
      )}
      {/* The active SOS / gather in the strip area while the bar's column is away (#708). */}
      {bandInStrip && chromeFree && !panel && (
        <AlertBands
          here={here}
          onNavigate={onNavigate}
          variant="strip"
          style={[styles.stripBand, { bottom: fabBottom + 8 }]}
        />
      )}
      {chromeFree && <SosButton bottom={pending ? fabBottom + 28 : fabBottom} here={here} />}
      {signal && !drawing && <UndoSnack style={snackStyle} />}
      {panel && <TeamPanel top={panelTop} here={here} focused={screenFocused} />}
      {draft !== null && (
        <KeyboardLifted style={cardStyle} testID="team-card-dock">
          <TeamPinComposer onPinned={(owner, id) => select({ kind: 'pin', owner, id })} />
        </KeyboardLifted>
      )}
      {!editing && draft === null && card && sheet !== null && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <TeamSheetCard sheet={sheet} here={here} onPointActions={onPointActions} />
        </View>
      )}
      {!drawing && draft === null && !card && cardSlotFree && hit === null && shapeCard && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <TeamShapeCard here={here} onNavigate={onNavigate} screenFocused={screenFocused} />
        </View>
      )}
      {signal && !drawing && <DrawAlertSnack style={{ bottom: fabBottom, right: 76 }} />}
      {draft === null && !card && cardSlotFree && pin && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <TeamPinCard pin={pin} view={view} here={here} onClose={() => select(null)} />
        </View>
      )}
      {draft === null && !card && cardSlotFree && member && row && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <TeammateCard
            member={member}
            row={row}
            here={here}
            onNavigate={onNavigate}
            onClose={() => select(null)}
          />
        </View>
      )}
      {draft === null && !card && cardSlotFree && wpt && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <View
            style={[
              styles.card,
              { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
            ]}
            testID="team-card"
          >
            <View style={styles.cardHead}>
              <Icon source="map-marker" size={28} color={t.ink} />
              <View style={styles.flex}>
                <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={1}>
                  {wpt.name}
                </Text>
                <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={2}>
                  {[
                    `${sharer ? `Shared by ${sharer.isMe ? 'you' : sharer.name}` : 'Shared waypoint'}${
                      wpt.note ? ` · ${wpt.note}` : ''
                    }`,
                    rb ? `${dist(rb.meters)} ${rb.compass}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <IconButton
                icon="close"
                size={20}
                onPress={() => select(null)}
                accessibilityLabel="Close"
              />
            </View>
            {target && (
              <Button
                mode="contained"
                icon="navigation-variant"
                compact
                onPress={() => {
                  onNavigate(target.lat, target.lon);
                  select(null);
                }}
              >
                Navigate
              </Button>
            )}
          </View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  /** Cards stop short of the SOS button's column. */
  card: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 12,
    gap: 8,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4 },
  /** The strip-area band: left of the SOS button, above the bottom chrome. */
  stripBand: { position: 'absolute', left: 16, right: 88, zIndex: MAP_OVERLAY_Z.teamButton },
});
