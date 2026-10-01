import type { TimelineEvent, TimelineEventKind } from '@core/geo/track';
import type { TimelineText } from '@core/library/trailViewText';
import { palette, type SchemeTokens } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

export interface TimelineItem {
  event: TimelineEvent;
  text: TimelineText;
}

interface Props {
  items: readonly TimelineItem[];
  /** The cursor's distance: the item under it is highlighted. */
  selectedDistanceM: number | null;
  onSelect: (event: TimelineEvent) => void;
  /** Still computing (first open of a long trail). */
  loading?: boolean;
}

function dotColor(kind: TimelineEventKind, t: SchemeTokens): string {
  switch (kind) {
    case 'start':
    case 'finish':
      return t.inkVariant;
    case 'note':
      return palette.sageDeep; // the note badges' green family
    case 'steep':
      return t.explore.trail;
    case 'summit':
      return t.data.ascent;
    case 'stop':
    case 'pause':
      return t.status.pausedInk;
  }
}

/**
 * Timeline tab (#511, board D): the outing as a vertical timeline. Each
 * event is a button — tapping it moves the profile cursor and the map
 * marker to that spot.
 */
export function TimelineTab({ items, selectedDistanceM, onSelect, loading }: Props) {
  const t = useSchemeTokens();
  if (loading) {
    return (
      <Text variant="bodySmall" style={[styles.pad, { color: t.inkMuted }]}>
        Reading the outing…
      </Text>
    );
  }
  return (
    <View style={styles.list} testID="trail-timeline">
      {items.map(({ event, text }, i) => {
        const last = i === items.length - 1;
        const on =
          selectedDistanceM !== null && Math.abs(event.at.distanceM - selectedDistanceM) < 1;
        return (
          <Pressable
            key={`${event.kind}-${i}`}
            onPress={() => onSelect(event)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${text.time ? `${text.time}, ` : ''}${text.title}. ${text.sub}`}
            accessibilityHint="Shows this point on the map and the profile"
            style={({ pressed }) => [
              styles.row,
              (on || pressed) && { backgroundColor: t.elevation.level2 },
            ]}
          >
            <View style={styles.rail}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: dotColor(event.kind, t) },
                  on && { borderColor: t.ink, borderWidth: 2 },
                ]}
              />
              {!last && <View style={[styles.line, { backgroundColor: t.outlineVariant }]} />}
            </View>
            <View style={styles.body}>
              <View style={styles.head}>
                {text.time !== null && (
                  <Text style={[styles.time, { color: t.inkMuted }]}>{text.time}</Text>
                )}
                <Text style={[styles.title, { color: t.ink }]} numberOfLines={2}>
                  {text.title}
                </Text>
              </View>
              {text.sub !== '' && (
                <Text style={[styles.sub, { color: t.inkVariant }]} numberOfLines={3}>
                  {text.sub}
                </Text>
              )}
              {event.photoUri ? (
                <Image source={{ uri: event.photoUri }} style={styles.photo} />
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16 },
  list: { paddingTop: 10, paddingBottom: 4 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16 },
  rail: { width: 22, alignItems: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, marginTop: 4 },
  line: { flex: 1, width: 2, marginTop: 2 },
  body: { flex: 1, paddingBottom: 18, gap: 3 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  time: { fontSize: 13, fontWeight: '800', minWidth: 46 },
  title: { flex: 1, fontSize: 16, fontWeight: '800' },
  sub: { fontSize: 13.5 },
  photo: { width: 150, height: 90, borderRadius: 10, marginTop: 4 },
});
