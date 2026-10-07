/** THROWAWAY mockups v2 (branch mockup/team-v2): team signal mode, action sheets, collaborative editing. */
import { GeoJSONSource, Layer, Marker } from '@maplibre/maplibre-react-native';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactElement } from 'react';
import { Image, StyleSheet, Text as RNText, View } from 'react-native';
import { Button, Icon, Switch, Text } from 'react-native-paper';
import { create } from 'zustand';

import { MemberAvatar } from '../components';

export type Shot =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o';
export const useMockV2 = create<{ shot: Shot | null; set: (s: Shot | null) => void }>((set) => ({
  shot: null,
  set: (shot) => set({ shot }),
}));

const TRAIL_SPOT: [number, number] = [-70.918242, 47.083358];
const LONG_PRESS: [number, number] = [-70.9232, 47.0848];
const V: [number, number][] = [
  [-70.91555, 47.082176],
  [-70.917195, 47.082598],
  [-70.918242, 47.083358],
  [-70.919492, 47.083876],
  [-70.919835, 47.085053],
  [-70.920541, 47.085734],
  [-70.921052, 47.086771],
  [-70.922469, 47.087556],
  [-70.924159, 47.087892],
];
const DRAGGED = 4;

type Fresh = 'fresh' | 'stale' | 'lost';
const CREW_MOCK: {
  name: string;
  short: string;
  init: string;
  color: string;
  at: [number, number];
  age: string;
  fresh: Fresh;
  status: string | null;
  statusIcon: string;
}[] = [
  { name: 'Alex (Guide)', short: 'Alex', init: 'AG', color: '#3F8FD8', at: [-70.9215, 47.0872], age: 'now', fresh: 'fresh', status: 'OK', statusIcon: 'check-circle' },
  { name: 'Julie Tremblay', short: 'Julie', init: 'JT', color: '#9B6ADE', at: [-70.9182, 47.0838], age: '2 min', fresh: 'fresh', status: 'Arrived', statusIcon: 'flag-checkered' },
  { name: 'Sam', short: 'Sam', init: 'S', color: '#1F9D7A', at: [-70.9248, 47.0855], age: '7 min', fresh: 'stale', status: 'Stopping 10 min', statusIcon: 'coffee' },
  { name: 'Léa (invitée)', short: 'Léa', init: 'L', color: '#C2410C', at: [-70.9285, 47.0889], age: '34 min', fresh: 'lost', status: null, statusIcon: '' },
];
const RALLY: [number, number] = [-70.9205, 47.0862];

function CrewMarker({ m, sos }: { m: (typeof CREW_MOCK)[number]; sos?: boolean }) {
  const lost = m.fresh === 'lost';
  return (
    <View pointerEvents="none" style={{ alignItems: 'center', opacity: m.fresh === 'stale' ? 0.55 : 1 }}>
      {sos && <View style={styles.sosHalo} />}
      <View
        style={[
          styles.crewDot,
          {
            backgroundColor: lost ? '#FFFFFF' : sos ? '#D32F2F' : m.color,
            borderColor: lost ? m.color : '#FFFFFF',
            borderStyle: lost ? 'dashed' : 'solid',
          },
        ]}
      >
        <RNText style={[styles.crewInit, { color: lost ? m.color : '#FFFFFF' }]}>{sos ? 'SOS' : m.init}</RNText>
      </View>
      <View style={styles.crewLabel}>
        <RNText style={styles.crewLabelText}>
          {lost ? `${m.short} · lost · ${m.age}` : `${m.short} · ${m.age}`}
        </RNText>
      </View>
      {m.status && !sos && (
        <View style={styles.statusPill}>
          <RNText style={styles.statusText}>{m.status}</RNText>
        </View>
      )}
    </View>
  );
}
const DRAG_TO: [number, number] = [-70.9182, 47.0858];
const INSERTED: [number, number] = [-70.92176, 47.08736];

function Ring({ color, size = 34 }: { color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 3,
        borderColor: color,
        backgroundColor: 'rgba(255,255,255,0.25)',
      }}
    />
  );
}

/** Map children for the current shot. */
export function useMockV2Marks(): ReactElement[] {
  const shot = useMockV2((s) => s.shot);
  const t = useSchemeTokens();
  const positions = useTeamStore((s) => s.positions);
  const julie = positions.find((p) => p.name.startsWith('Julie'));
  const out: ReactElement[] = [];
  if (shot === 'b') {
    out.push(
      <Marker key="mb" id="mock-b" lngLat={TRAIL_SPOT} anchor="center">
        <View pointerEvents="none">
          <Ring color={t.team.bubbleNew} size={38} />
        </View>
      </Marker>,
    );
  }
  void julie;
  if (shot !== null && 'cghijklm'.includes(shot)) {
    for (const m of CREW_MOCK) {
      out.push(
        <Marker key={`crew-${m.init}`} id={`mock-crew-${m.init}`} lngLat={m.at} anchor="top">
          <CrewMarker m={m} sos={shot === 'j' && m.short === 'Sam'} />
        </Marker>,
      );
    }
  }
  if (shot === 'c') {
    out.push(
      <Marker key="mc" id="mock-c" lngLat={CREW_MOCK[1]!.at} anchor="center" offset={[0, 20]}>
        <View pointerEvents="none">
          <Ring color={t.team.bubbleNew} size={52} />
        </View>
      </Marker>,
    );
  }
  if (shot === 'h' || shot === 'm') {
    out.push(
      <GeoJSONSource
        key="rally-src"
        id="mock-rally-src"
        data={{
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              Array.from({ length: 41 }, (_, i) => {
                const a = (i / 40) * 2 * Math.PI;
                return [RALLY[0] + (60 / 75_800) * Math.cos(a), RALLY[1] + (60 / 111_320) * Math.sin(a)];
              }),
            ],
          },
        }}
      >
        <Layer id="mock-rally-fill" type="fill" paint={{ 'fill-color': '#E07B39', 'fill-opacity': 0.18 }} />
        <Layer id="mock-rally-line" type="line" paint={{ 'line-color': '#E07B39', 'line-width': 2, 'line-dasharray': [2, 1] }} />
      </GeoJSONSource>,
      <Marker key="rally" id="mock-rally" lngLat={RALLY} anchor="bottom">
        <View pointerEvents="none" style={{ alignItems: 'center' }}>
          <View style={styles.rallyFlag}>
            <Icon source="flag-variant" size={18} color="#FFFFFF" />
            <RNText style={styles.rallyText}>Meet here · 14:00</RNText>
          </View>
          <View style={[styles.lpTail, { borderTopColor: '#E07B39' }]} />
        </View>
      </Marker>,
    );
  }
  if (shot === 'd' || shot === 'o') {
    out.push(
      <Marker key="md" id="mock-d" lngLat={LONG_PRESS} anchor="bottom">
        <View pointerEvents="none" style={{ alignItems: 'center' }}>
          <View style={[styles.lpPin, { backgroundColor: t.team.bubbleNew, borderColor: palette.white }]}>
            <Icon source="plus" size={18} color={palette.white} />
          </View>
          <View style={[styles.lpTail, { borderTopColor: t.team.bubbleNew }]} />
        </View>
      </Marker>,
    );
  }
  if (shot === 'e') {
    const moved = V.map((p, i) => (i === DRAGGED ? DRAG_TO : p));
    const edited: [number, number][] = [...moved.slice(0, 7), INSERTED, ...moved.slice(7)];
    out.push(
      <GeoJSONSource
        key="me-src"
        id="mock-e-src"
        data={{
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { k: 'old' },
              geometry: { type: 'LineString', coordinates: V.slice(3, 6) },
            },
            {
              type: 'Feature',
              properties: { k: 'new' },
              geometry: { type: 'LineString', coordinates: edited },
            },
          ],
        }}
      >
        <Layer
          id="mock-e-old"
          type="line"
          filter={['==', ['get', 'k'], 'old']}
          paint={{ 'line-color': '#8A8F94', 'line-width': 3, 'line-dasharray': [2, 2] }}
        />
        <Layer
          id="mock-e-new"
          type="line"
          filter={['==', ['get', 'k'], 'new']}
          paint={{ 'line-color': '#E07B39', 'line-width': 5 }}
        />
      </GeoJSONSource>,
    );
    edited.forEach((p, i) => {
      const dragged = p === DRAG_TO;
      const inserted = p === INSERTED;
      out.push(
        <Marker key={`mv${i}`} id={`mock-v${i}`} lngLat={p} anchor="center">
          <View
            pointerEvents="none"
            style={[
              styles.vertex,
              dragged && styles.vertexBig,
              {
                backgroundColor: inserted ? '#E07B39' : palette.white,
                borderColor: dragged ? '#2F6F8F' : '#E07B39',
              },
            ]}
          >
            {inserted && <Icon source="plus" size={12} color={palette.white} />}
            {dragged && <Icon source="cursor-move" size={16} color="#2F6F8F" />}
          </View>
        </Marker>,
      );
    });
    out.push(
      <Marker key="mj" id="mock-julie-edit" lngLat={V[8]!} anchor="bottom-left" offset={[10, -6]}>
        <View pointerEvents="none" style={[styles.presence, { backgroundColor: '#9B6ADE' }]}>
          <View style={[styles.presenceDot, { borderColor: palette.white }]}>
            <RNText style={styles.presenceInit}>JT</RNText>
          </View>
          <RNText style={styles.presenceText}>Julie is editing</RNText>
        </View>
      </Marker>,
    );
  }
  return out;
}

function Sheet({ children }: { children: React.ReactNode }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.dock} pointerEvents="box-none">
      <View style={[styles.sheet, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}>
        {children}
      </View>
    </View>
  );
}

function Action({ icon, label, sub }: { icon: string; label: string; sub?: string }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.action}>
      <View style={[styles.actionIcon, { backgroundColor: t.surfaceVariant }]}>
        <Icon source={icon} size={22} color={t.ink} />
      </View>
      <View style={styles.flex}>
        <Text variant="titleSmall" style={{ color: t.ink }}>
          {label}
        </Text>
        {sub ? (
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            {sub}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Grid({ items }: { items: [string, string][] }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.grid}>
      {items.map(([icon, label]) => (
        <View key={label} style={styles.gridItem}>
          <View style={[styles.gridIcon, { backgroundColor: t.surfaceVariant }]}>
            <Icon source={icon} size={24} color={t.ink} />
          </View>
          <Text variant="labelMedium" style={{ color: t.ink, textAlign: 'center' }}>
            {label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The persistent team-mode indicator + the shot's sheet. */
/** Hides the search pill and the team chip while a mockup shot is up (team mode). */
export function useTeamModeMock(): boolean {
  return useMockV2((s) => s.shot !== null);
}

function Card({ children }: { children: React.ReactNode }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.dock3} pointerEvents="box-none">
      <View style={[styles.card3, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}>
        {children}
      </View>
    </View>
  );
}

function IconRow({ items }: { items: [string, string][] }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.iconRow}>
      {items.map(([icon, label]) => (
        <View key={label} style={styles.iconItem}>
          <View style={[styles.iconBtn, { backgroundColor: t.surfaceVariant }]}>
            <Icon source={icon} size={24} color={t.ink} />
          </View>
          <Text variant="labelSmall" style={{ color: t.ink, textAlign: 'center' }} numberOfLines={2}>
            {label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Head({ icon, title, sub, color }: { icon?: string; title: string; sub?: string; color?: string }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.row}>
      {icon ? <Icon source={icon} size={24} color={color ?? t.ink} /> : null}
      <View style={styles.flex}>
        <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Icon source="chevron-up" size={22} color={t.inkMuted} />
    </View>
  );
}


/** Photo tap → a bottom card (swipe down to close, up for full screen). */
function PhotoCard() {
  const t = useSchemeTokens();
  const photos = useTeamStore((s) => s.photos);
  const ph = photos.find((x) => /sommet/i.test(x.caption ?? '')) ?? photos[0];
  return (
    <View style={styles.photoDock} pointerEvents="none">
      <View style={[styles.photoCard, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}>
        <View style={[styles.grabber, { backgroundColor: t.outlineVariant }]} />
        <View style={styles.row}>
          {ph?.thumbUri ? (
            <Image source={{ uri: ph.thumbUri }} style={styles.photoThumb} />
          ) : (
            <View style={[styles.photoThumb, { backgroundColor: t.surfaceVariant }]} />
          )}
          <View style={styles.flex}>
            <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={2}>
              {ph?.caption ?? 'Au sommet'}
            </Text>
            <Text variant="bodySmall" style={{ color: t.inkVariant }}>
              Oct 4 · 10:24 · km 3.1 · 799 m
            </Text>
            <Text variant="bodySmall" style={{ color: t.inkVariant }}>
              Marc-André · 2 comments
            </Text>
          </View>
        </View>
        <View style={[styles.commentLine, { borderColor: t.outlineVariant }]}>
          <MemberAvatar initials="AG" color="#3F8FD8" size={22} />
          <Text variant="bodySmall" style={[styles.flex, { color: t.ink }]} numberOfLines={1}>
            Alex: Superbe vue au sommet ! On repart à 14 h?
          </Text>
        </View>
        <IconRow
          items={[
            ['comment-text-outline', 'Comment'],
            ['checkbox-marked-circle-plus-outline', 'Task'],
            ['share-variant-outline', 'Share'],
            ['arrow-expand', 'Full screen'],
          ]}
        />
      </View>
    </View>
  );
}

/** The one team control: a round action button, bottom right, in thumb reach. */
function TeamFab({ open, sos }: { open: boolean; sos: boolean }) {
  return (
    <View style={styles.fabWrap} pointerEvents="none">
      {sos && <View style={styles.fabSos} />}
      <View style={[styles.fab, { borderColor: sos ? '#D32F2F' : '#E07B39' }]}>
        <Icon source={open ? 'close' : 'account-group'} size={28} color="#FFFFFF" />
      </View>
      {!open && (
        <View style={[styles.fabBadge, { backgroundColor: sos ? '#D32F2F' : '#E07B39' }]}>
          <RNText style={styles.fabBadgeText}>{sos ? 'SOS' : '3'}</RNText>
        </View>
      )}
    </View>
  );
}

const MENU: [string, string, string?][] = [
  ['hand-back-left', 'SOS · hold', '#D32F2F'],
  ['account-multiple', 'Members · 4'],
  ['message-text-outline', 'Team chat · 3'],
  ['flag-variant', 'Rally point'],
  ['checkbox-marked-circle-plus-outline', 'New task'],
  ['bell-ring-outline', 'Notify someone'],
  ['check-circle-outline', 'My status · OK'],
];

export function MockV2Overlay({ top }: { top: number }) {
  const t = useSchemeTokens();
  const shot = useMockV2((s) => s.shot);
  const view = useTeamStore((s) => s.view);
  void top;
  if (shot === null) return null;
  const julie = view?.members.find((m) => m.name.startsWith('Julie'));
  const menuOpen = shot === 'l';
  return (
    <>
      {shot !== 'o' && <TeamFab open={menuOpen} sos={shot === 'j'} />}
      {menuOpen && (
        <View style={styles.menu} pointerEvents="none">
          {MENU.map(([icon, label, c]) => (
            <View key={label} style={styles.menuRow}>
              <View style={[styles.menuLabel, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}>
                <Text variant="labelLarge" style={{ color: c ?? t.ink }}>
                  {label}
                </Text>
              </View>
              <View
                style={[
                  styles.menuBtn,
                  { backgroundColor: c ?? t.elevation.level2, shadowColor: palette.shadow },
                ]}
              >
                <Icon source={icon} size={24} color={c ? '#FFFFFF' : t.ink} />
              </View>
            </View>
          ))}
        </View>
      )}

      {shot === 'n' && <PhotoCard />}
      {shot === 'o' && (
        <>
          <View style={styles.lpChipLane} pointerEvents="none">
            <View style={styles.lpChip}>
              <RNText style={styles.lpChipTitle}>47.08480, −70.92320</RNText>
              <RNText style={styles.lpChipSub}>Elevation 512 m · 640 m NW of you</RNText>
              <View style={styles.lpChipRow}>
                {['Navigate', 'Copy', 'Convert'].map((l) => (
                  <View key={l} style={styles.lpChipBtn}>
                    <RNText style={styles.lpChipBtnText}>{l}</RNText>
                  </View>
                ))}
              </View>
            </View>
          </View>
          <View style={styles.dock3} pointerEvents="none">
            <View style={[styles.pill3, { backgroundColor: t.ink }]}>
              <Icon source="gesture-tap-hold" size={20} color={t.background} />
              <Text variant="labelLarge" style={{ color: t.background }}>
                Tip: hold anywhere for coordinates and Navigate
              </Text>
            </View>
          </View>
        </>
      )}
      {shot === 'a' && (
        <Card>
          <Text variant="labelMedium" style={{ color: t.inkMuted }}>
            MAP OVERLAYS › EXTENSIONS
          </Text>
          <View style={styles.row}>
            <Icon source="account-group" size={24} color={t.ink} />
            <View style={styles.flex}>
              <Text variant="titleSmall" style={{ color: t.ink }}>
                Team mode
              </Text>
              <Text variant="bodySmall" style={{ color: t.inkVariant }}>
                On: taps on the map signal the team · the team button appears
              </Text>
            </View>
            <Switch value onValueChange={() => undefined} />
          </View>
        </Card>
      )}
      {shot === 'b' && (
        <Card>
          <Head icon="map-marker-path" title="Sentier du sommet · km 2.4" sub="Shared by Marc-André · edited by Julie" />
          <IconRow
            items={[
              ['comment-text-outline', 'Comment'],
              ['checkbox-marked-circle-plus-outline', 'Task'],
              ['camera-outline', 'Photo'],
              ['bell-ring-outline', 'Notify'],
              ['vector-polyline-edit', 'Edit trail'],
            ]}
          />
        </Card>
      )}
      {shot === 'c' && (
        <Card>
          <View style={styles.row}>
            <MemberAvatar initials={julie?.initials ?? 'JT'} color={julie?.color ?? '#9B6ADE'} size={36} />
            <View style={styles.flex}>
              <Text variant="titleSmall" style={{ color: t.ink }}>
                Julie Tremblay · Arrived
              </Text>
              <Text variant="bodySmall" style={{ color: t.inkVariant }}>
                2 min ago · ±5 m · 640 m NE
              </Text>
            </View>
          </View>
          <IconRow
            items={[
              ['message-text-outline', 'Message'],
              ['checkbox-marked-circle-plus-outline', 'Task'],
              ['map-marker-question-outline', 'Where are you?'],
              ['crosshairs-gps', 'Centre'],
              ['navigation-variant-outline', 'Go to'],
            ]}
          />
        </Card>
      )}
      {shot === 'd' && (
        <Card>
          <Head icon="crosshairs" title="Here · 180 m off the trail" sub="47.0848, −70.9232" />
          <IconRow
            items={[
              ['vector-polyline-plus', 'Add to trail'],
              ['map-marker-plus-outline', 'Waypoint'],
              ['bell-ring-outline', 'Notify'],
              ['camera-outline', 'Photo'],
              ['checkbox-marked-circle-plus-outline', 'Task'],
              ['flag-variant', 'Meet here'],
            ]}
          />
          <View style={[styles.secondary, { borderTopColor: t.outlineVariant }]}>
            {['Navigate here', 'Coordinates', 'Convert'].map((l) => (
              <Text key={l} variant="labelLarge" style={{ color: t.inkVariant }}>
                {l}
              </Text>
            ))}
          </View>
        </Card>
      )}
      {shot === 'e' && (
        <Card>
          <Head icon="vector-polyline-edit" title="Editing the trail · Julie too" sub="Drag a point · tap a segment to insert" />
          <View style={styles.tools}>
            {(
              [
                ['undo', 'Undo'],
                ['vector-point-plus', 'Insert'],
                ['vector-point-minus', 'Delete'],
                ['arrow-expand-right', 'Extend'],
                ['check', 'Done'],
              ] as [string, string][]
            ).map(([icon, label]) => (
              <View key={label} style={styles.tool}>
                <View style={[styles.iconBtn, { backgroundColor: label === 'Done' ? t.ink : t.surfaceVariant }]}>
                  <Icon source={icon} size={22} color={label === 'Done' ? t.background : t.ink} />
                </View>
                <Text variant="labelSmall" style={{ color: t.ink }}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      )}
      {shot === 'f' && (
        <Card>
          <Head icon="bell-ring-outline" title="Notify · this spot" />
          <View style={styles.row}>
            {(view?.members ?? [])
              .filter((m) => !m.isMe && m.active)
              .map((m, i) => (
                <View key={m.id} style={styles.pickWho}>
                  <View style={[styles.pickRing, { borderColor: i < 2 ? t.ink : 'transparent' }]}>
                    <MemberAvatar initials={m.initials} color={m.color} size={40} />
                  </View>
                  <Text variant="labelSmall" style={{ color: t.ink }} numberOfLines={1}>
                    {m.name.split(' ')[0]}
                  </Text>
                </View>
              ))}
          </View>
          <View style={styles.chips}>
            {['Come here', 'Look at this', 'Wait', 'Need help'].map((c, i) => (
              <View
                key={c}
                style={[
                  styles.chip,
                  { borderColor: i === 0 ? t.ink : t.outlineVariant, backgroundColor: i === 0 ? t.surfaceVariant : 'transparent' },
                ]}
              >
                <Text variant="labelLarge" style={{ color: t.ink }}>
                  {c}
                </Text>
              </View>
            ))}
          </View>
          <Button mode="contained" icon="bell-ring-outline" compact>
            Notify 2
          </Button>
        </Card>
      )}
      {shot === 'g' && (
        <Card>
          <Text variant="titleSmall" style={{ color: t.ink }}>
            My status
          </Text>
          <View style={styles.statusRow}>
            {(
              [
                ['check-circle', 'OK', '#1F7A4D'],
                ['flag-checkered', 'Arrived', '#2F6F8F'],
                ['account-group', 'Regroup', '#6A4BB5'],
                ['coffee', '10 min', '#8A5A00'],
                ['hand-back-left', 'Help', '#B3261E'],
              ] as [string, string, string][]
            ).map(([icon, label, c], i) => (
              <View key={label} style={styles.statusItem}>
                <View style={[styles.statusBtn, { borderColor: c, backgroundColor: i === 0 ? c : 'transparent' }]}>
                  <Icon source={icon} size={30} color={i === 0 ? '#FFFFFF' : c} />
                </View>
                <Text variant="labelMedium" style={{ color: t.ink }}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      )}
      {shot === 'h' && (
        <Card>
          <Head icon="flag-variant" color="#E07B39" title="Meet here · 14:00 · 1/5 arrived" sub="Next: Alex 2 min · Sam 6 min · you 9 min" />
          <View style={styles.row}>
            {(
              [
                ['AG', '#3F8FD8', '2 min', false],
                ['JT', '#9B6ADE', '✓', true],
                ['S', '#1F9D7A', '6 min', false],
                ['L', '#C2410C', 'lost', false],
                ['MA', '#E07B39', '9 min', false],
              ] as [string, string, string, boolean][]
            ).map(([init, c, eta, ok]) => (
              <View key={init} style={styles.etaItem}>
                <MemberAvatar initials={init} color={c} size={32} />
                <Text variant="labelSmall" style={{ color: ok ? '#1F7A4D' : t.inkVariant }}>
                  {eta}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      )}
      {shot === 'm' && (
        <View style={styles.dock3} pointerEvents="none">
          <View style={[styles.pill3, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}>
            <Icon source="flag-variant" size={20} color="#E07B39" />
            <Text variant="labelLarge" style={{ color: t.ink }}>
              Meet 14:00 · 1/5 arrived · you 9 min
            </Text>
            <Icon source="chevron-up" size={20} color={t.inkMuted} />
          </View>
        </View>
      )}
      {shot === 'i' && (
        <Card>
          <View style={styles.row}>
            <View style={styles.sosHold}>
              <View style={styles.sosHoldArc} />
              <RNText style={styles.sosHoldText}>SOS</RNText>
            </View>
            <View style={styles.flex}>
              <Text variant="titleSmall" style={{ color: t.ink }}>
                Keep holding · 1.2 s
              </Text>
              <Text variant="bodySmall" style={{ color: t.inkVariant }}>
                Alerts every member, even big teams · stays pinned until you or an admin resolves it
              </Text>
            </View>
          </View>
        </Card>
      )}
      {shot === 'j' && (
        <>
          <View style={[styles.sosBanner, { top: 56 }]} pointerEvents="none">
            <Icon source="alert-octagon" size={26} color="#FFFFFF" />
            <View style={styles.flex}>
              <RNText style={styles.sosBannerTitle}>SOS · Sam needs help</RNText>
              <RNText style={styles.sosBannerSub}>420 m NW · live · 13:58</RNText>
            </View>
          </View>
          <Card>
            <View style={styles.row}>
              <Button mode="contained" icon="navigation-variant" style={styles.flex} buttonColor="#D32F2F">
                Go to Sam
              </Button>
              <Button mode="outlined" icon="hand-wave" style={styles.flex}>
                I’m coming
              </Button>
            </View>
          </Card>
        </>
      )}
      {shot === 'k' && (
        <Card>
          <View style={styles.row}>
            <MemberAvatar initials="S" color="#1F9D7A" size={36} />
            <View style={styles.flex}>
              <Text variant="titleSmall" style={{ color: t.ink }}>
                Sam · Stopping 10 min
              </Text>
              <Text variant="bodySmall" style={{ color: '#8A5A00' }}>
                Position 7 min old · faded on the map
              </Text>
            </View>
          </View>
          <View style={styles.legend}>
            {(
              [
                ['Fresh < 5 min', 1, 'solid'],
                ['Stale 5–15 min', 0.55, 'solid'],
                ['Lost > 15 min', 1, 'dashed'],
              ] as [string, number, 'solid' | 'dashed'][]
            ).map(([l, o, b]) => (
              <View key={l} style={styles.legendItem3}>
                <View
                  style={[
                    styles.legendDot3,
                    { opacity: o, borderStyle: b, backgroundColor: b === 'dashed' ? 'transparent' : '#1F9D7A' },
                  ]}
                />
                <Text variant="labelSmall" style={{ color: t.ink }}>
                  {l}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  secondary: { flexDirection: 'row', justifyContent: 'space-around', borderTopWidth: 1, paddingTop: 8 },
  photoDock: { position: 'absolute', left: 0, right: 0, bottom: 84, zIndex: 22 },
  photoCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 14,
    paddingTop: 8,
    gap: 10,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3 },
  photoThumb: { width: 120, height: 90, borderRadius: 12 },
  commentLine: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, paddingTop: 8 },
  lpChipLane: { position: 'absolute', left: 0, right: 0, top: 300, alignItems: 'center', zIndex: 20 },
  lpChip: { backgroundColor: '#1E252B', borderRadius: 12, padding: 10, gap: 4, minWidth: 230 },
  lpChipTitle: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  lpChipSub: { color: '#C9D1D8', fontSize: 12 },
  lpChipRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  lpChipBtn: { borderRadius: 8, backgroundColor: '#33404A', paddingHorizontal: 10, paddingVertical: 6 },
  lpChipBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  dock3: { position: 'absolute', left: 8, right: 84, bottom: 92, zIndex: 20 },
  card3: {
    borderRadius: 16,
    padding: 12,
    gap: 10,
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  pill3: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    borderRadius: 24,
    paddingHorizontal: 14,
    height: 48,
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  iconRow: { flexDirection: 'row', justifyContent: 'space-between' },
  iconItem: { alignItems: 'center', gap: 4, flex: 1 },
  iconBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  fabWrap: { position: 'absolute', right: 16, bottom: 96, zIndex: 25, alignItems: 'center', justifyContent: 'center' },
  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#2B3137',
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabSos: { position: 'absolute', width: 84, height: 84, borderRadius: 42, backgroundColor: 'rgba(211,47,47,0.3)' },
  fabBadge: { position: 'absolute', top: -4, right: -6, minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, borderWidth: 2, borderColor: '#FFFFFF' },
  fabBadgeText: { color: '#FFFFFF', fontWeight: '900', fontSize: 11 },
  menu: { position: 'absolute', right: 16, bottom: 168, zIndex: 25, gap: 10, alignItems: 'flex-end' },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  menuLabel: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, shadowOpacity: 0.2, shadowRadius: 6, elevation: 3 },
  menuBtn: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', shadowOpacity: 0.25, shadowRadius: 6, elevation: 4 },
  pickWho: { alignItems: 'center', gap: 2, width: 60 },
  pickRing: { borderWidth: 3, borderRadius: 26, padding: 1 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statusItem: { alignItems: 'center', gap: 4 },
  statusBtn: { width: 58, height: 58, borderRadius: 29, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  etaItem: { alignItems: 'center', gap: 2, flex: 1 },
  sosHold: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#D32F2F', alignItems: 'center', justifyContent: 'center' },
  sosHoldArc: { position: 'absolute', top: -6, left: -6, width: 88, height: 88, borderRadius: 44, borderWidth: 6, borderColor: 'transparent', borderTopColor: '#D32F2F', borderRightColor: '#D32F2F', transform: [{ rotate: '45deg' }] },
  sosHoldText: { color: '#FFFFFF', fontSize: 22, fontWeight: '900' },
  legendItem3: { alignItems: 'center', gap: 4, flex: 1 },
  legendDot3: { width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: '#1F9D7A' },
  flex: { flex: 1 },
  dock: { position: 'absolute', left: 8, right: 8, bottom: 96, zIndex: 20 },
  sheet: {
    borderRadius: 18,
    padding: 16,
    gap: 12,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  actionIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 },
  gridItem: { width: '33.3%', alignItems: 'center', gap: 6 },
  gridIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  indicatorLane: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 6 },
  indicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    height: 30,
    borderRadius: 15,
  },
  indicatorText: { fontSize: 13, fontWeight: '700' },
  lpPin: { width: 34, height: 34, borderRadius: 17, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  lpTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  vertex: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  vertexBig: { width: 30, height: 30, borderRadius: 15 },
  presence: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 10, borderRadius: 14, height: 28 },
  presenceDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  presenceInit: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  presenceText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  tools: { flexDirection: 'row', justifyContent: 'space-between' },
  crewDot: { width: 34, height: 34, borderRadius: 17, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  crewInit: { fontWeight: '800', fontSize: 11 },
  crewLabel: { marginTop: 2, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 6, paddingHorizontal: 5 },
  crewLabelText: { color: '#14181C', fontSize: 11, fontWeight: '800' },
  statusPill: { marginTop: 2, backgroundColor: '#14181C', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  statusText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
  sosHalo: { position: 'absolute', top: -10, width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(211,47,47,0.3)' },
  rallyFlag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#E07B39', borderRadius: 14, paddingHorizontal: 10, height: 28 },
  rallyText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  bigGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  bigBtn: { width: '31%', minHeight: 84, borderWidth: 2, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 6 },
  sosWrap: { alignItems: 'center', paddingVertical: 6 },
  sosRingOuter: { width: 168, height: 168, borderRadius: 84, borderWidth: 10, borderColor: 'rgba(211,47,47,0.2)', alignItems: 'center', justifyContent: 'center' },
  sosRingProgress: { position: 'absolute', top: -10, left: -10, width: 168, height: 168, borderRadius: 84, borderWidth: 10, borderColor: 'transparent', borderTopColor: '#D32F2F', borderRightColor: '#D32F2F', transform: [{ rotate: '45deg' }] },
  sosButton: { width: 132, height: 132, borderRadius: 66, backgroundColor: '#D32F2F', alignItems: 'center', justifyContent: 'center' },
  sosBig: { color: '#FFFFFF', fontSize: 34, fontWeight: '900' },
  sosSmall: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  sosBanner: { position: 'absolute', left: 8, right: 8, zIndex: 30, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#B3261E', borderRadius: 14, padding: 12 },
  sosBannerTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  sosBannerSub: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  legend: { flexDirection: 'row', justifyContent: 'space-between' },
  legendItem: { alignItems: 'center', gap: 4 },
  legendDot: { width: 26, height: 26, borderRadius: 13, borderWidth: 3, borderColor: '#1F9D7A' },
  tool: { alignItems: 'center', gap: 4, minWidth: 56 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
});
