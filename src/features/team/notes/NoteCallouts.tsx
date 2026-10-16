/**
 * Notes on the main map (#706, mockup "Notes on the map"): a callout per note
 * (author colour bar, "Julie · 12 min", the text, a tail to the spot and a
 * dot on it), an orange dot while unread, a softer shadow once read, fading
 * to half over the last fifth of its life; where callouts would overlap, and
 * always below ~1:50 000, a tile with a count (`@core/teamui/notes`). While
 * composing, the preview sits dashed where the note will land.
 *
 * The text is plain React Native `Text` (no linking, no markup), already
 * clean (R-NOTE-1). Marker children are inert Views (a Pressable inside a
 * MapLibre marker stops it drawing on iOS; `onPress` never fires on Android):
 * taps are hit-tested by MapScreen through {@link hitTestNotes}, against the
 * sizes the callouts measured.
 */
import {
  noteMarks,
  noteOpacity,
  noteSpan,
  noteUnread,
  type NoteMark,
  type NotePin,
} from '@core/teamui/notes';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { Marker } from '@maplibre/maplibre-react-native';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useEffect, useMemo } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { useNow } from '../components';
import { useOwnColour } from '../draw/drawShared';
import { usePinDraft } from '../map/TeamPinComposer';
import { noteColor } from './noteParts';

/** The dot on the spot, and the gap between it and the callout's tail (dp). */
const DOT = 12;
const GAP = 13;

export type NoteHit =
  | { kind: 'note'; owner: string; id: string }
  | { kind: 'tile'; lngLat: [number, number]; pins: readonly NotePin[] };

interface Drawn {
  key: string;
  hit: NoteHit;
  lngLat: [number, number];
  /** Callouts hang above their spot; tiles sit centred on it. */
  hang: boolean;
}

/** What is on the map now, in drawing order (the hit test reads it). */
let drawn: readonly Drawn[] = [];
/** Each view's measured size (dp), by key, once laid out. */
const sizes = new Map<string, { w: number; h: number }>();

/** The note (or tile) under a tap at (px, py), or null. */
export async function hitTestNotes(
  map: { project: (lngLat: [number, number]) => Promise<[number, number] | null | undefined> },
  px: number,
  py: number,
): Promise<NoteHit | null> {
  for (const d of [...drawn].reverse()) {
    const size = sizes.get(d.key);
    if (size === undefined) continue;
    let p: [number, number] | null | undefined;
    try {
      p = await map.project(d.lngLat);
    } catch {
      return null; // mid-teardown
    }
    if (!p) continue;
    const { w, h } = size;
    const slop = 6;
    const inside = d.hang
      ? Math.abs(px - p[0]) <= w / 2 + slop &&
        py <= p[1] + DOT / 2 + slop &&
        py >= p[1] + DOT / 2 - h - slop
      : Math.abs(px - p[0]) <= w / 2 + slop && Math.abs(py - p[1]) <= h / 2 + slop;
    if (inside) return d.hit;
  }
  return null;
}

/** Tests: forget what was drawn. */
export function resetNoteHitsForTests(): void {
  drawn = [];
  sizes.clear();
}

const measure = (key: string) => (e: LayoutChangeEvent) => {
  sizes.set(key, { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
};

/** What a mark answers to a tap, and where. */
function drawnOf(m: NoteMark): Drawn {
  if (m.kind === 'tile')
    return {
      key: m.key,
      hit: { kind: 'tile', lngLat: [m.lng, m.lat], pins: m.pins },
      lngLat: [m.lng, m.lat],
      hang: false,
    };
  return {
    key: m.key,
    hit: { kind: 'note', owner: m.pin.owner, id: m.pin.id },
    lngLat: [m.pin.lng, m.pin.lat],
    hang: true,
  };
}

function Callout({
  color,
  by,
  text,
  unread,
  read,
  opacity,
  ghost,
  onLayout,
  testID,
}: {
  color: string;
  by: string;
  text: string;
  unread: boolean;
  read: boolean;
  opacity: number;
  ghost?: boolean;
  onLayout?: (e: LayoutChangeEvent) => void;
  testID: string;
}) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.wrap, { opacity }]}
      pointerEvents="none"
      onLayout={onLayout}
      testID={testID}
      accessible
      accessibilityLabel={`Note, ${by}: ${text}`}
    >
      <View
        style={[
          styles.card,
          { backgroundColor: t.surface, shadowColor: palette.shadow },
          read ? styles.read : styles.unreadShadow,
          ghost && { borderWidth: 2, borderStyle: 'dashed', borderColor: color, opacity: 0.92 },
        ]}
      >
        <View style={[styles.bar, { backgroundColor: color }]} />
        <View style={styles.byRow}>
          <View style={[styles.byDot, { backgroundColor: color }]} />
          <Text style={[styles.by, { color: t.inkMuted }]} numberOfLines={1}>
            {by}
          </Text>
        </View>
        <Text style={[styles.text, { color: t.ink }]}>{text}</Text>
        {unread && (
          <View
            style={[styles.unread, { backgroundColor: t.team.bubbleNew, borderColor: t.surface }]}
            testID={`${testID}-unread`}
          />
        )}
      </View>
      <View style={[styles.tail, { backgroundColor: t.surface }]} />
      <View style={[styles.dot, { backgroundColor: color, borderColor: t.team.mapPaper }]} />
    </View>
  );
}

function Tile({
  mark,
  onLayout,
}: {
  mark: Extract<NoteMark, { kind: 'tile' }>;
  onLayout: (e: LayoutChangeEvent) => void;
}) {
  const t = useSchemeTokens();
  const c = noteColor(mark.color);
  const n = mark.pins.length;
  return (
    <View
      style={[
        styles.tile,
        { backgroundColor: t.surface, borderColor: c, shadowColor: palette.shadow },
      ]}
      pointerEvents="none"
      onLayout={onLayout}
      testID="note-tile"
      accessible
      accessibilityLabel={n > 1 ? `${n} notes` : 'A note'}
    >
      <Icon source="note-text" size={18} color={c} />
      {n > 1 && (
        <View style={[styles.count, { backgroundColor: mark.unread ? t.team.bubbleNew : t.ink }]}>
          <Text
            style={[styles.countText, { color: mark.unread ? t.team.bubbleNewInk : t.surface }]}
          >
            {n > 99 ? '99+' : n}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * The note callouts as MapView children (an array). Memoised: MapScreen
 * re-renders on every fix; this follows the notes, the settled zoom, and a
 * minute clock for ages and fades.
 */
export const NoteCallouts = memo(function NoteCallouts({ zoom }: { zoom: number | null }) {
  const { installedAt, show } = useExtensionPrefs('team');
  const pins = useTeamStore((s) => s.pins);
  const view = useTeamStore((s) => s.view);
  const seen = useTeamStore((s) => s.record?.seen);
  const draft = usePinDraft();
  const own = useOwnColour();
  const now = useNow(60_000);
  const z = Math.round((zoom ?? 15) * 4) / 4;
  const me = view?.me ?? '';
  const names = useMemo(
    () => new Map((view?.members ?? []).map((m) => [m.id, m.isMe ? 'You' : m.name.split(' ')[0]!])),
    [view],
  );
  const seenAt = useMemo(() => (th: string) => seen?.[th] ?? 0, [seen]);
  const marks = useMemo(
    () => noteMarks(pins, z, now, (p) => noteUnread(p, me, seenAt)),
    [pins, z, now, me, seenAt],
  );
  const on = installedAt !== 0 && show && view !== null;
  useEffect(() => {
    drawn = on ? marks.map(drawnOf) : [];
  }, [on, marks]);
  if (!on) return [];

  const out = marks.map((m) => {
    if (m.kind === 'tile') {
      return (
        <Marker key={m.key} id={`note-${m.key}`} lngLat={[m.lng, m.lat]} anchor="center">
          <Tile mark={m} onLayout={measure(m.key)} />
        </Marker>
      );
    }
    const p = m.pin;
    const unread = noteUnread(p, me, seenAt);
    return (
      <Marker
        key={m.key}
        id={`note-${m.key}`}
        lngLat={[p.lng, p.lat]}
        anchor="bottom"
        offset={[0, DOT / 2]}
      >
        <Callout
          color={noteColor(p.note.color)}
          by={`${names.get(p.owner) ?? 'Teammate'} · ${noteSpan(now - p.messages[0]!.at)}`}
          text={p.note.text}
          unread={unread}
          read={!unread}
          opacity={noteOpacity(p.note, now)}
          onLayout={measure(m.key)}
          testID="note-callout"
        />
      </Marker>
    );
  });
  if (draft.at !== null) {
    out.push(
      <Marker
        key="note-preview"
        id="note-preview"
        lngLat={draft.at}
        anchor="bottom"
        offset={[0, DOT / 2]}
      >
        <Callout
          color={noteColor(draft.col ?? own)}
          by="You · preview"
          text={draft.text.trim() || '…'}
          unread={false}
          read
          opacity={1}
          ghost
          testID="note-preview"
        />
      </Marker>,
    );
  }
  return out;
});

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', maxWidth: 176 },
  card: {
    borderRadius: 12,
    paddingLeft: 10,
    paddingRight: 9,
    paddingTop: 5,
    paddingBottom: 6,
    overflow: 'visible',
    maxWidth: 176,
    elevation: 5,
  },
  unreadShadow: { shadowOpacity: 0.28, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  read: {
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  bar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    borderTopLeftRadius: 12,
    borderBottomLeftRadius: 12,
  },
  byRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 1 },
  byDot: { width: 8, height: 8, borderRadius: 4 },
  by: { fontSize: 10.5, fontWeight: '800', flexShrink: 1 },
  text: { fontSize: 12.5, lineHeight: 16, fontWeight: '700' },
  unread: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  tail: { width: 10, height: 10, marginTop: -5, transform: [{ rotate: '45deg' }] },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 2.5, marginTop: GAP - 5 },
  tile: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  count: {
    position: 'absolute',
    top: -7,
    right: -8,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontSize: 10, fontWeight: '900' },
});
