/**
 * The note list (#706, mockup "Team panel › Notes"): All, New and Mine; New
 * holds the notes I have not opened (orange dot), Earlier the rest, each with
 * who, how far, and a small time-left ring; faded notes stay in a collapsed
 * "Faded · last 24 h" group, then they are gone. A tap on a row closes the
 * list and opens the note's card on the map.
 */
import {
  lifeLeft,
  noteSections,
  noteSpan,
  type NoteFilter,
  type NoteRow,
} from '@core/teamui/notes';
import { rangeAndBearing } from '@core/teamui/positions';
import { distanceText } from '@core/teamui/teamBar';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from '@ui/paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { myPosition } from '../bar/parts';
import { MemberAvatar, useNow } from '../components';
import { useTeamMapFocus } from '../map/teamMapFocus';
import { useTeamMapSelection } from '../map/TeamMapOverlay';
import { LifeRing } from './noteParts';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

const FILTERS: readonly { id: NoteFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'mine', label: 'Mine' },
];

export function NotesScreen() {
  const { sz } = useDisplayScale();

  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const pins = useTeamStore((s) => s.pins);
  const view = useTeamStore((s) => s.view);
  const seen = useTeamStore((s) => s.record?.seen);
  // Distances from my last known fix (the list is off the map).
  const [here, setHere] = useState<{ latitude: number; longitude: number } | null>(null);
  useEffect(() => {
    let live = true;
    void myPosition(null).then((p) => {
      if (live && p) setHere({ longitude: p[0], latitude: p[1] });
    });
    return () => {
      live = false;
    };
  }, []);
  const now = useNow(60_000);
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [showFaded, setShowFaded] = useState(false);
  const me = view?.me ?? '';
  const s = noteSections(pins, me, (th) => seen?.[th] ?? 0, now, filter);
  const byId = new Map((view?.members ?? []).map((m) => [m.id, m]));

  const open = (r: NoteRow) => {
    useTeamMapSelection.getState().select({ kind: 'pin', owner: r.pin.owner, id: r.pin.id });
    useTeamMapFocus.getState().focus(r.pin.lng, r.pin.lat);
    router.back();
  };

  const row = (r: NoteRow) => {
    const m = byId.get(r.pin.owner);
    const who = r.mine ? 'You' : (m?.name.split(' ')[0] ?? 'Teammate');
    const rb = here ? rangeAndBearing(here, { lat: r.pin.lat, lon: r.pin.lng }) : null;
    const where = rb ? `${distanceText(rb.meters, units)} ${rb.compass}` : null;
    return (
      <Pressable
        key={`${r.pin.owner}:${r.pin.id}`}
        onPress={() => open(r)}
        style={[styles.row, { borderBottomColor: t.divider }, r.faded && styles.faded]}
        accessibilityRole="button"
        testID="note-row"
      >
        <MemberAvatar initials={m?.initials ?? '?'} color={m?.color ?? t.inkMuted} size={sz(34)} />
        <View style={styles.flex}>
          <Text style={[styles.text, { color: t.ink }, r.unread && styles.bold]} numberOfLines={2}>
            {r.pin.note.text}
          </Text>
          <View style={styles.meta}>
            <Text style={[styles.metaText, { color: t.inkMuted }]} numberOfLines={1}>
              {[who, where].filter(Boolean).join(' · ')}
            </Text>
            <Text style={[styles.metaText, { color: t.inkMuted }]}>·</Text>
            {r.faded ? (
              <Text style={[styles.metaText, { color: t.inkMuted }]}>
                {`Faded ${noteSpan(now - r.pin.note.expiresAt)} ago`}
              </Text>
            ) : (
              <>
                <LifeRing left={lifeLeft(r.pin.note, now)} color={t.inkMuted} size={16} />
                <Text style={[styles.metaText, { color: t.inkMuted }]}>
                  {noteSpan(r.pin.note.expiresAt - now)}
                </Text>
              </>
            )}
          </View>
        </View>
        {r.unread && <View style={[styles.dot, { backgroundColor: t.team.bubbleNew }]} />}
      </Pressable>
    );
  };

  return (
    <View
      style={[styles.fill, { backgroundColor: t.background, paddingTop: insets.top }]}
      testID="team-notes-screen"
    >
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.ib}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Icon source="arrow-left" size={24} color={t.ink} />
        </Pressable>
        <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
          Notes
        </Text>
        <Pressable
          onPress={() => router.back()}
          style={styles.ib}
          accessibilityRole="button"
          accessibilityLabel="Map"
        >
          <Icon source="map-outline" size={24} color={t.ink} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xl }]}
      >
        <View style={styles.chips}>
          {FILTERS.map((f) => {
            const on = f.id === filter;
            return (
              <Pressable
                key={f.id}
                onPress={() => setFilter(f.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                testID={`notes-filter-${f.id}`}
                style={[
                  styles.chip,
                  on
                    ? { backgroundColor: t.library.chipOn, borderColor: t.library.chipOn }
                    : { backgroundColor: t.library.chip, borderColor: t.library.chipBorder },
                ]}
              >
                <Text
                  style={[styles.chipText, { color: on ? t.library.chipOnInk : t.library.chipInk }]}
                >
                  {f.label}
                </Text>
                <Text
                  style={[
                    styles.chipCount,
                    { color: on ? t.library.chipOnCount : t.library.chipCount },
                  ]}
                >
                  {s.counts[f.id]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {s.fresh.length > 0 && <Section label="New" />}
        {s.fresh.map(row)}
        {s.earlier.length > 0 && <Section label="Earlier" />}
        {s.earlier.map(row)}
        {s.faded.length > 0 && (
          <Pressable
            onPress={() => setShowFaded((v) => !v)}
            style={styles.fadedHead}
            accessibilityRole="button"
            accessibilityState={{ expanded: showFaded }}
            testID="notes-faded"
          >
            <Icon
              source={showFaded ? 'chevron-down' : 'chevron-right'}
              size={18}
              color={t.inkMuted}
            />
            <Text style={[styles.sect, { color: t.inkMuted }]}>Faded · last 24 h</Text>
            <Text style={[styles.sectCount, { color: t.inkMuted }]}>{`(${s.faded.length})`}</Text>
          </Pressable>
        )}
        {showFaded && s.faded.map(row)}
        {s.fresh.length + s.earlier.length + s.faded.length === 0 && (
          <Text style={[styles.empty, { color: t.inkMuted }]}>
            {filter === 'mine' ? 'You have no notes on the map.' : 'No notes on the map.'}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function Section({ label }: { label: string }) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  return (
    <Text style={[styles.sect, styles.sectPad, { color: t.inkMuted }]} accessibilityRole="header">
      {label.toUpperCase()}
    </Text>
  );
}

const stylesSheet = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
  },
  ib: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 22, fontWeight: '800' },
  body: { paddingHorizontal: 16, paddingTop: 6 },
  chips: { flexDirection: 'row', gap: 8, marginTop: 2, marginBottom: 8 },
  chip: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  chipText: { fontSize: 14.5, fontWeight: '800' },
  chipCount: { fontSize: 14.5, fontWeight: '700' },
  sect: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  sectPad: { marginTop: 14, marginBottom: 2 },
  sectCount: { fontSize: 11, fontWeight: '700' },
  fadedHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 14,
    marginBottom: 2,
    minHeight: 32,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
    paddingRight: 4,
    borderBottomWidth: 1,
  },
  faded: { opacity: 0.6 },
  text: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  bold: { fontWeight: '800' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  metaText: { fontSize: 12.5, fontWeight: '700' },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 8 },
  empty: { marginTop: 24, textAlign: 'center', fontSize: 15 },
});
