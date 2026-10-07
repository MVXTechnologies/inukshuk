/**
 * The team's marks on the main map (#589, mockups `a-map`, `b-map-pin`):
 * comment bubbles beside shared photos (orange with the count of new ones,
 * white with the total once seen), pins (the author's initials, with their
 * thread count), and open tasks hanging under what they are anchored to.
 *
 * MapLibre Markers, visual only (plain Views, no Pressable: the
 * MapPointChip lesson): taps are hit-tested at the map level by
 * {@link hitTestTeamMarks}, which projects each mark's anchor and checks the
 * box it is drawn in (Marker onPress doesn't fire on Android).
 */
import { teamMapMarks, type BubbleMark, type PinMark, type TaskMark } from '@core/teamui/mapMarks';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { Marker } from '@maplibre/maplibre-react-native';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { useAnchorLookup } from '../useAnchorLookup';

/** Below this zoom, only pins are drawn (bubbles and tasks crowd a wide view). */
export const MARKS_MIN_ZOOM = 12;
export const PINS_MIN_ZOOM = 9;

/** Where each kind is drawn relative to its anchor's screen point (pt): a tap box. */
const BUBBLE_BOX = { dx: 12, dy: -40, w: 52, h: 28 };
const PIN_BOX = { dx: -22, dy: -60, w: 60, h: 60 };
const TASK_W = 190;
const TASK_H = 28;
const taskBox = (m: TaskMark) => ({
  dx: -14,
  dy: (m.under === 'point' ? 6 : 26) + m.stack * (TASK_H + 4),
  w: TASK_W,
  h: TASK_H,
});

export type TeamMarkHit =
  | { kind: 'bubble'; mark: BubbleMark }
  | { kind: 'pin'; mark: PinMark }
  | { kind: 'task'; mark: TaskMark };

interface Target {
  lngLat: [number, number];
  box: { dx: number; dy: number; w: number; h: number };
  hit: TeamMarkHit;
}

/** The marks drawn last render, topmost last (the hit test walks them backwards). */
let targets: Target[] = [];

/** What a map tap at (px, py) hits among the team's marks, or null. */
export async function hitTestTeamMarks(
  map: { project: (lngLat: [number, number]) => Promise<[number, number] | number[]> },
  px: number,
  py: number,
): Promise<TeamMarkHit | null> {
  for (let i = targets.length - 1; i >= 0; i--) {
    const tg = targets[i]!;
    try {
      const p = await map.project(tg.lngLat);
      const x = p[0];
      const y = p[1];
      if (x === undefined || y === undefined) continue;
      const left = x + tg.box.dx;
      const top = y + tg.box.dy;
      if (px >= left && px <= left + tg.box.w && py >= top && py <= top + tg.box.h) return tg.hit;
    } catch {
      return null; // map mid-teardown
    }
  }
  return null;
}

function Bubble({ count, fresh }: { count: number; fresh: boolean }) {
  const t = useSchemeTokens();
  const bg = fresh ? t.team.bubbleNew : t.team.mapPaper;
  const ink = fresh ? t.team.bubbleNewInk : t.team.mapInk;
  return (
    <View
      style={[styles.bubble, { backgroundColor: bg, borderColor: fresh ? t.team.mapPaper : ink }]}
    >
      <Icon source="comment" size={12} color={ink} />
      <Text style={[styles.bubbleText, { color: ink }]}>{count}</Text>
    </View>
  );
}

/** The marks as MapView children (an array), for the map's current zoom. */
export function useTeamMapMarks(zoom: number | null): ReactElement[] {
  const t = useSchemeTokens();
  const { installedAt, show } = useExtensionPrefs('team');
  const view = useTeamStore((s) => s.view);
  const photos = useTeamStore((s) => s.photos);
  const threads = useTeamStore((s) => s.photoThreads);
  const allPins = useTeamStore((s) => s.pins);
  const resolved = useTeamStore((s) => s.resolved);
  const pins = useMemo(
    () => allPins.filter((p) => !resolved.has(`${p.owner}:${p.id}`)),
    [allPins, resolved],
  );
  const tasks = useTeamStore((s) => s.tasks);
  const seen = useTeamStore((s) => s.record?.seen);
  const look = useAnchorLookup();

  const marks = useMemo(() => {
    if (view === null) return null;
    const byId = new Map(view.members.map((m) => [m.id, m]));
    return teamMapMarks({
      photos,
      threads,
      pins,
      tasks,
      me: view.me,
      seenAt: (th) => seen?.[th] ?? 0,
      look,
      nameOf: (id) => byId.get(id)?.name ?? 'Teammate',
    });
  }, [view, photos, threads, pins, tasks, seen, look]);

  const on = installedAt !== 0 && show;
  const near = zoom === null || zoom >= MARKS_MIN_ZOOM;
  const pinsShown = zoom === null || zoom >= PINS_MIN_ZOOM;
  const drawn = useMemo(() => {
    const next: Target[] = [];
    const out: ReactElement[] = [];
    if (on && marks !== null && view !== null) {
      if (near) {
        for (const b of marks.bubbles) {
          const lngLat: [number, number] = [b.photo.lng, b.photo.lat];
          next.push({ lngLat, box: BUBBLE_BOX, hit: { kind: 'bubble', mark: b } });
          out.push(
            <Marker
              key={`tb-${b.key}`}
              id={`team-bubble-${b.key}`}
              lngLat={lngLat}
              anchor="bottom-left"
              offset={[14, -14]}
            >
              <View pointerEvents="none" accessibilityLabel={`${b.count} comments`}>
                <Bubble count={b.count} fresh={b.fresh} />
              </View>
            </Marker>,
          );
        }
      }
      if (pinsShown) {
        for (const p of marks.pins) {
          const m = view.members.find((x) => x.id === p.owner);
          const lngLat: [number, number] = [p.lng, p.lat];
          next.push({ lngLat, box: PIN_BOX, hit: { kind: 'pin', mark: p } });
          out.push(
            <Marker key={`tp-${p.key}`} id={`team-pin-${p.key}`} lngLat={lngLat} anchor="bottom">
              <View
                style={styles.pinWrap}
                pointerEvents="none"
                accessibilityLabel={`Pin by ${m?.name ?? 'a teammate'}`}
                testID="team-map-pin"
              >
                <View
                  style={[
                    styles.pinHead,
                    { borderColor: t.team.mapPaper, backgroundColor: m?.color ?? t.inkMuted },
                  ]}
                >
                  <Text style={[styles.pinText, { color: t.team.onAvatar }]}>
                    {m?.initials ?? '?'}
                  </Text>
                </View>
                <View style={[styles.pinTail, { borderTopColor: t.team.mapPaper }]} />
                <View style={styles.pinBubble}>
                  <Bubble count={p.count} fresh={p.fresh} />
                </View>
              </View>
            </Marker>,
          );
        }
      }
      if (near) {
        for (const k of marks.tasks) {
          const lngLat: [number, number] = [k.lng, k.lat];
          const box = taskBox(k);
          next.push({ lngLat, box, hit: { kind: 'task', mark: k } });
          out.push(
            <Marker
              key={`tt-${k.key}`}
              id={`team-task-${k.key}`}
              lngLat={lngLat}
              anchor="top-left"
              offset={[box.dx, box.dy]}
            >
              <View
                pointerEvents="none"
                style={[
                  styles.task,
                  { backgroundColor: t.team.mapPaper, borderColor: t.team.mapInk },
                ]}
                accessibilityLabel={`Task: ${k.label}`}
              >
                <Icon source="checkbox-blank-outline" size={15} color={t.team.mapInk} />
                <Text style={[styles.taskText, { color: t.team.mapInk }]} numberOfLines={1}>
                  {k.label}
                </Text>
              </View>
            </Marker>,
          );
        }
      }
    }
    return { next, out };
  }, [on, near, pinsShown, marks, view, t]);
  useEffect(() => {
    targets = drawn.next;
    return () => {
      targets = [];
    };
  }, [drawn]);
  // An array, never a Fragment, as MapView children (mapLayers.tsx).
  return drawn.out;
}

const styles = StyleSheet.create({
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
  },
  bubbleText: { fontSize: 12, fontWeight: '800' },
  pinWrap: { alignItems: 'center', width: 64, height: 58 },
  pinHead: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  pinText: { fontWeight: '800', fontSize: 13 },
  pinTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: -1,
  },
  pinBubble: { position: 'absolute', right: -6, top: 0 },
  task: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    height: TASK_H,
    maxWidth: TASK_W,
    borderRadius: 8,
    borderWidth: 1.5,
  },
  taskText: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
});
