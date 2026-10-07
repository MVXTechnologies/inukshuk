/**
 * Team mode's chrome on the map (#589, mockups v2): in signal mode the team
 * action button (bottom right, its badge the only team indicator) and its
 * compact cards; the popup of a tapped teammate (status, position age,
 * distance; message, task, "where are you?", centre, go to) or shared
 * waypoint; pins and the pin composer. A plain themed View
 * for the card (paper-surface-ios-flex-collapse); its own state store so
 * MapScreen only routes the tap.
 */
import { rangeAndBearing, shortAge } from '@core/teamui/positions';
import { STATUS_LABEL } from '@core/teamui/system';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text } from 'react-native-paper';
import { create } from 'zustand';

import { MemberAvatar } from '../components';
import { TEAM_TAP_LAYERS } from './layerIds';
import { Round, TeamFab, TeamSheetCard } from './TeamCards';
import { useTeamMapFocus } from './teamMapFocus';
import { useTeamSheet, useTeamSignalMode } from './teamMode';
import { usePhotoCard } from '@features/photos/PhotoBottomCard';
import { RallyPill, SosBanner } from './TeamField';
import { TrailEditBar, useTrailEdit } from './TrailEditor';
import { TeamPinCard } from './TeamPinCard';
import { useTeamPick } from './TeamPick';
import { TeamPinComposer, usePinDraft } from './TeamPinComposer';

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

const dist = (m: number) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

export function TeamMapOverlay({
  here,
  cardStyle,
  cardSlotFree,
  fabBottom,
  sosTop,
  onNavigate,
  onPointActions,
}: {
  /** My position, for distance and bearing. */
  here: { latitude: number; longitude: number } | null;
  cardStyle: StyleProp<ViewStyle>;
  cardSlotFree: boolean;
  /** Where the team button sits (above the bottom chrome). */
  fabBottom: number;
  /** Where the SOS banner sits (under the status bar). */
  sosTop: number;
  onNavigate: (latitude: number, longitude: number) => void;
  /** Long-press menu's secondary row: Navigate here / Coordinates / Convert. */
  onPointActions: (at: [number, number], what: 'navigate' | 'coordinates' | 'convert') => void;
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  const { installedAt, show } = useExtensionPrefs('team');
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const statuses = useTeamStore((s) => s.statuses);
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
  if (installedAt === 0 || !show || view === null) return null;

  const member = hit?.kind === 'member' ? positions.find((p) => p.id === hit.id) : undefined;
  const row = member ? view.members.find((m) => m.id === member.id) : undefined;
  const wpt = hit?.kind === 'waypoint' ? shares.waypoints.find((w) => w.id === hit.id) : undefined;
  const target = member
    ? { lat: member.lat, lon: member.lon }
    : wpt
      ? { lat: wpt.lat, lon: wpt.lon }
      : null;
  const rb = target && here ? rangeAndBearing(here, target) : null;
  const pin =
    hit?.kind === 'pin' ? pins.find((p) => p.owner === hit.owner && p.id === hit.id) : undefined;
  const status = member ? statuses.get(member.id) : undefined;
  const card = sheet !== null && sheet.kind !== 'menu';

  return (
    <>
      {editing && <TrailEditBar style={[cardStyle, styles.leaveFab]} />}
      {/* An open SOS is pinned at the top for everyone, signal mode or not. */}
      <SosBanner top={sosTop} here={here} onNavigate={onNavigate} />
      {/* The rally point's pill: signal mode, no card up. */}
      {signal &&
        !picking &&
        draft === null &&
        hit === null &&
        photoCard === null &&
        (sheet === null || sheet.kind === 'menu') && (
          <RallyPill bottom={fabBottom} here={here} onNavigate={onNavigate} />
        )}
      {/* The team button never covers a card: any card, sheet or popup hides it. */}
      {signal &&
        !picking &&
        !editing &&
        cardSlotFree &&
        draft === null &&
        hit === null &&
        photoCard === null &&
        (sheet === null || sheet.kind === 'menu') && <TeamFab bottom={fabBottom} />}
      {draft !== null && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <TeamPinComposer onPinned={(owner, id) => select({ kind: 'pin', owner, id })} />
        </View>
      )}
      {!editing && draft === null && card && sheet !== null && (
        <View style={[cardStyle, styles.leaveFab]} pointerEvents="box-none" testID="team-card-dock">
          <TeamSheetCard sheet={sheet} here={here} onPointActions={onPointActions} />
        </View>
      )}
      {draft === null && !card && cardSlotFree && pin && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <TeamPinCard pin={pin} view={view} here={here} onClose={() => select(null)} />
        </View>
      )}
      {draft === null && !card && cardSlotFree && member && row && (
        <View style={[cardStyle, styles.leaveFab]} pointerEvents="box-none" testID="team-card-dock">
          <View
            style={[
              styles.card,
              { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
            ]}
            testID="team-card"
          >
            <View style={styles.cardHead}>
              <MemberAvatar initials={row.initials} color={row.color} size={36} />
              <View style={styles.flex}>
                <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={1}>
                  {status ? `${member.name} · ${STATUS_LABEL[status.id]}` : member.name}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: member.band === 'fresh' ? t.inkVariant : t.status.gpsLostInk }}
                  numberOfLines={1}
                  testID="team-card-range"
                >
                  {[
                    member.band === 'lost'
                      ? `lost · ${shortAge(member.ageMs)} ago`
                      : shortAge(member.ageMs) === 'now'
                        ? 'just now'
                        : `${shortAge(member.ageMs)} ago`,
                    member.accuracy !== null ? `±${Math.round(member.accuracy)} m` : null,
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
            <View style={styles.roundRow}>
              <Round
                icon="message-text-outline"
                label="Message"
                testID="team-member-message"
                onPress={() => {
                  select(null);
                  router.push('/team/chat');
                }}
              />
              {row.role !== 'guest' && view.members.find((m) => m.isMe)?.role !== 'guest' && (
                <Round
                  icon="checkbox-marked-circle-plus-outline"
                  label="Task"
                  testID="team-member-task"
                  onPress={() => {
                    select(null);
                    router.push(`/team/task-new?to=${member.id}` as never);
                  }}
                />
              )}
              <Round
                icon="map-marker-question-outline"
                label="Where are you?"
                testID="team-member-where"
                onPress={() => {
                  const session = teamService()?.active;
                  const text = `@${member.name} where are you?`;
                  session?.sendMessage(text, {
                    mentions: [member.id],
                    aud: { m: [member.id, view.me] },
                  });
                  useTeamStore.getState().refresh();
                  select(null);
                }}
              />
              <Round
                icon="crosshairs-gps"
                label="Centre"
                testID="team-member-centre"
                onPress={() => useTeamMapFocus.getState().focus(member.lon, member.lat, 16)}
              />
              <Round
                icon="navigation-variant-outline"
                label="Go to"
                testID="team-member-goto"
                onPress={() => {
                  onNavigate(member.lat, member.lon);
                  select(null);
                }}
              />
            </View>
          </View>
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
                    `Shared waypoint${wpt.note ? ` · ${wpt.note}` : ''}`,
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
  /** Cards stop short of the team button's column. */
  leaveFab: { right: 84 },
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
  roundRow: { flexDirection: 'row', justifyContent: 'space-around' },
});
