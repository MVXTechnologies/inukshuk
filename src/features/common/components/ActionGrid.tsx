/**
 * The long-press grid (#744 option 2, #757): every action one tap away, five
 * a row, a 44 dp disc over a label of up to two lines. The team long-press
 * card and the normal-mode point card share it. A plain themed View.
 */
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from '@ui/paper';
import { useScaledStyles } from '@ui/displayScale';

/** The grid's labels grow with the font scale up to this. */
export const GRID_LABEL_MAX_SCALE = 1.15;

/** One cell of the long-press grid (#744 option 2): a 44 dp disc over a label of up to two lines. */
export function GridItem({
  icon,
  label,
  onPress,
  testID,
  accent,
  tag,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  testID: string;
  /** The disc's own fill and ink (Meet here's gather amber). */
  accent?: { bg: string; ink: string };
  /** A small "NEW" on the disc's corner (a feature just added, #706). */
  tag?: string;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      style={styles.gridItem}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <View
        style={[
          styles.gridDisc,
          accent
            ? { backgroundColor: accent.bg, borderColor: accent.bg }
            : // The ring keeps the disc visible where surfaceVariant equals the
              // card's level2 (dark: both #242B32, #744 QA).
              { backgroundColor: t.surfaceVariant, borderColor: t.outlineVariant },
        ]}
      >
        <Icon source={icon} size={22} color={accent ? accent.ink : t.ink} />
        {tag !== undefined && (
          <View style={[styles.tag, { backgroundColor: t.team.bubbleNew }]} pointerEvents="none">
            <Text style={[styles.tagText, { color: t.team.bubbleNewInk }]} allowFontScaling={false}>
              {tag}
            </Text>
          </View>
        )}
      </View>
      <Text
        variant="labelSmall"
        style={[styles.gridLabel, { color: t.ink }]}
        numberOfLines={2}
        // A fifth of a 360 dp card is 64 dp: "Waypoint" fits up to 1.15× (#756/#757).
        maxFontSizeMultiplier={GRID_LABEL_MAX_SCALE}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A cell of a long-press grid. */
export interface GridCell {
  icon: string;
  label: string;
  testID: string;
  run: () => void;
  accent?: { bg: string; ink: string };
  tag?: string;
}

/** The wrapping grid (#744 option 2): five a row, every action one tap away. */
export function PressGrid({ cells, testID }: { cells: readonly GridCell[]; testID: string }) {
  const styles = useScaledStyles(stylesSheet);

  return (
    <View style={styles.grid} testID={testID}>
      {cells.map((c) => (
        <GridItem
          key={c.testID}
          icon={c.icon}
          label={c.label}
          onPress={c.run}
          testID={c.testID}
          {...(c.accent ? { accent: c.accent } : {})}
          {...(c.tag !== undefined ? { tag: c.tag } : {})}
        />
      ))}
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  // Five a row (#744 option 2): a fifth each, labels wrap under their disc.
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10, paddingTop: 2 },
  gridItem: { width: '20%', alignItems: 'center', gap: 4, paddingHorizontal: 1 },
  gridDisc: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridLabel: { textAlign: 'center' },
  tag: {
    position: 'absolute',
    top: -6,
    right: -12,
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  tagText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
});
