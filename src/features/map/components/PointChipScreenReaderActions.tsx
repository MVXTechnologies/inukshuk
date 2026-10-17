import type { PointChipHit } from '@core/map/mapTap';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@ui/paper';

import { useScreenReaderEnabled } from '../../common/useScreenReaderEnabled';
import { MAP_POINT_ACTION_LABELS } from './MapPointChip';
import { useScaledStyles } from '@ui/displayScale';

interface Props {
  /** The chip's readout as a sentence ("Point 46.81, -71.21, 120 m NE"). */
  label: string;
  onAction: (hit: PointChipHit) => void;
  onClose: () => void;
  /** Where the panel sits. */
  top: number;
}

const ROWS: readonly { hit: PointChipHit; label: string; text: string }[] = [
  { hit: 'navigate', label: MAP_POINT_ACTION_LABELS.navigate, text: 'Navigate' },
  { hit: 'waypoint', label: MAP_POINT_ACTION_LABELS.waypoint, text: 'Waypoint' },
  { hit: 'convert', label: MAP_POINT_ACTION_LABELS.convert, text: 'Convert' },
  { hit: 'copy', label: 'Copy coordinates', text: 'Copy' },
];

/**
 * The long-press callout for screen readers (2.5.1 QA). The callout itself is
 * a MapLibre marker: Android rasterizes marker children, so TalkBack never
 * reaches it, and its "tap to copy" is a map-level hit-test no screen reader
 * can aim. While a screen reader is on, the same readout and the same
 * actions are offered here as real, labelled controls, announced when they
 * appear. Nothing renders for sighted users.
 */
export function PointChipScreenReaderActions(props: Props) {
  const screenReader = useScreenReaderEnabled();
  if (!screenReader) return null;
  return <Panel {...props} />;
}

function Panel({ label, onAction, onClose, top }: Props) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  return (
    <View
      style={[styles.panel, { top, backgroundColor: tokens.map.chrome }]}
      accessibilityLiveRegion="polite"
      testID="point-chip-a11y"
    >
      <Text
        style={[styles.label, { color: tokens.map.chromeInk }]}
        accessibilityRole="header"
        numberOfLines={2}
      >
        {label}
      </Text>
      <View style={styles.row}>
        {ROWS.map((r) => (
          <Pressable
            key={r.hit}
            onPress={() => onAction(r.hit)}
            accessibilityRole="button"
            accessibilityLabel={r.label}
            style={[styles.button, { borderColor: tokens.map.chromeDivider }]}
          >
            <Text style={[styles.buttonText, { color: tokens.map.chromeInk }]}>{r.text}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close point"
          style={[styles.button, { borderColor: tokens.map.chromeDivider }]}
        >
          <Text style={[styles.buttonText, { color: tokens.map.chromeInk }]}>Close</Text>
        </Pressable>
      </View>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderRadius: 16,
    padding: 10,
    gap: 8,
    zIndex: 9,
  },
  label: { fontSize: 14, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
  },
  buttonText: { fontSize: 14, fontWeight: '700' },
});
