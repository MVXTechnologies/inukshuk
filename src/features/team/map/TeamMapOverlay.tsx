/**
 * Team mode's chrome on the map (#589, mockup `team-map`): the team chip in
 * the top-centre lane (under the receiver chip when that one is up) and the
 * card of a tapped teammate or shared waypoint — distance and bearing from
 * me, the fix's age and accuracy, Navigate and Message. A plain themed View
 * for the card (paper-surface-ios-flex-collapse); its own state store so
 * MapScreen only routes the tap.
 */
import { rangeAndBearing, shortAge } from '@core/teamui/positions';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { useReceiverChip } from '@features/gnss/useReceiverChip';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import type { StyleProp, ViewStyle } from 'react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text } from 'react-native-paper';
import { create } from 'zustand';

import { MemberAvatar, ROLE_LABEL } from '../components';
import { openPeers } from '../syncLine';
import { TEAM_TAP_LAYERS } from './layerIds';
import { TeamPinCard } from './TeamPinCard';
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
  top,
  here,
  cardStyle,
  cardSlotFree,
  onNavigate,
}: {
  top: number;
  /** My position, for distance and bearing. */
  here: { latitude: number; longitude: number } | null;
  cardStyle: StyleProp<ViewStyle>;
  cardSlotFree: boolean;
  onNavigate: (latitude: number, longitude: number) => void;
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  const { installedAt, show } = useExtensionPrefs('team');
  const view = useTeamStore((s) => s.view);
  const peers = useTeamStore((s) => s.peers);
  const unread = useTeamStore((s) => s.unread);
  const positions = useTeamStore((s) => s.positions);
  const shares = useTeamStore((s) => s.shares);
  const pins = useTeamStore((s) => s.pins);
  const draft = usePinDraft((s) => s.at);
  const meshRunning = useTeamStore((s) => s.meshRunning);
  const hit = useTeamMapSelection((s) => s.hit);
  const select = useTeamMapSelection((s) => s.select);
  const gnssChip = useReceiverChip();
  if (installedAt === 0 || !show || view === null) return null;

  const nearby = openPeers(peers).length;
  const others = view.activeCount - 1;
  const faces = view.members.filter((m) => m.active).slice(0, 4);
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

  return (
    <>
      <View style={[styles.lane, { top: top + (gnssChip ? 44 : 0) }]} pointerEvents="box-none">
        <Pressable
          onPress={() => router.push('/team')}
          style={[
            styles.chip,
            { backgroundColor: t.elevation.level2, borderColor: t.outlineVariant },
          ]}
          accessibilityRole="button"
          accessibilityLabel={`${view.name}, ${nearby} of ${others} teammates nearby${unread ? `, ${unread} unread` : ''}`}
          testID="team-map-chip"
        >
          <View style={styles.faces}>
            {faces.map((m, i) => (
              <View
                key={m.id}
                style={[styles.face, i > 0 && styles.overlap, { borderColor: t.elevation.level2 }]}
              >
                <MemberAvatar initials={m.initials} color={m.color} size={24} />
              </View>
            ))}
          </View>
          <Text variant="labelLarge" style={[styles.chipName, { color: t.ink }]} numberOfLines={1}>
            {view.name}
          </Text>
          <Text variant="labelMedium" style={{ color: t.inkVariant }} numberOfLines={1}>
            {!meshRunning
              ? '· not syncing'
              : others === 0
                ? '· just you'
                : `· ${nearby}/${others} nearby`}
          </Text>
          {unread > 0 && <View style={[styles.dot, { backgroundColor: t.status.gpsLostInk }]} />}
        </Pressable>
      </View>

      {draft !== null && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <TeamPinComposer onPinned={(owner, id) => select({ kind: 'pin', owner, id })} />
        </View>
      )}
      {draft === null && cardSlotFree && pin && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <TeamPinCard pin={pin} view={view} here={here} onClose={() => select(null)} />
        </View>
      )}
      {draft === null && cardSlotFree && (member || wpt) && (
        <View style={cardStyle} pointerEvents="box-none" testID="team-card-dock">
          <View
            style={[
              styles.card,
              { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
            ]}
            testID="team-card"
          >
            <View style={styles.cardHead}>
              {member && row ? (
                <MemberAvatar initials={row.initials} color={row.color} size={36} />
              ) : (
                <Icon source="map-marker" size={28} color={t.ink} />
              )}
              <View style={styles.flex}>
                <Text variant="titleMedium" style={{ color: t.ink }} numberOfLines={1}>
                  {member ? member.name : wpt?.name}
                </Text>
                <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={2}>
                  {member
                    ? `${ROLE_LABEL[member.role]} · ${shortAge(member.ageMs) === 'now' ? 'just now' : `${shortAge(member.ageMs)} ago`}${member.accuracy !== null ? ` · ±${Math.round(member.accuracy)} m` : ''}`
                    : `Shared waypoint${wpt?.note ? ` · ${wpt.note}` : ''}`}
                </Text>
              </View>
              <IconButton icon="close" onPress={() => select(null)} accessibilityLabel="Close" />
            </View>
            <View style={styles.rangeRow}>
              <Icon source="navigation-variant-outline" size={18} color={t.inkVariant} />
              <Text variant="titleSmall" style={{ color: t.ink }} testID="team-card-range">
                {rb
                  ? `${dist(rb.meters)} ${rb.compass} · ${Math.round(rb.bearingDeg)}°`
                  : 'Your position is unknown'}
              </Text>
            </View>
            <View style={styles.actions}>
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
              {member && (
                <Button
                  mode="outlined"
                  icon="message-text-outline"
                  compact
                  onPress={() => {
                    select(null);
                    router.push('/team/chat');
                  }}
                >
                  Message
                </Button>
              )}
            </View>
          </View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  lane: { position: 'absolute', left: 76, right: 76, alignItems: 'center', zIndex: 5 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 6,
    paddingRight: 12,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '100%',
  },
  chipName: { flexShrink: 1 },
  faces: { flexDirection: 'row' },
  face: { borderWidth: 2, borderRadius: 14 },
  overlap: { marginLeft: -10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  card: {
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
    gap: 8,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', gap: 8 },
});
