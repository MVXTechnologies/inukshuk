import { CATALOG_CATEGORY_LABELS, type CatalogCategory } from '@core/catalog/schema';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { Card, Text, useTheme } from 'react-native-paper';

/**
 * The Search tab's landing grid: large tappable category cards, so browsing
 * starts with "what kind of map" instead of a 30 000-row wall. Only categories
 * the catalog index actually reports render — empty ones hide, and the grid
 * grows on its own as the catalog gains sources.
 *
 * Counts come from the index's per-category totals, not from the items loaded
 * so far, so "Nautical · 1 204 charts" is honest before a single shard has been
 * fetched. Renders a plain View: the landing owns one scroll container so
 * "Around you" and the grid scroll together.
 */

/** MaterialCommunityIcons name per category (UI concern — kept out of core). */
const CATEGORY_ICONS: Record<CatalogCategory, keyof typeof MaterialCommunityIcons.glyphMap> = {
  topo: 'terrain',
  parks: 'pine-tree',
  geological: 'layers-triple-outline',
  aerial: 'airplane',
  forest: 'forest',
  hunting: 'target',
  touristic: 'map-marker-star-outline',
  nautical: 'anchor',
  river: 'kayaking',
};

/** "1 map" / "1,204 maps" — thousands separated, because world counts are big. */
function countLabel(count: number): string {
  return count === 1 ? '1 map' : `${count.toLocaleString('en-US')} maps`;
}

export function CategoryGrid({
  categories,
  counts,
  onSelect,
}: {
  categories: readonly CatalogCategory[];
  counts: Partial<Record<CatalogCategory, number>>;
  onSelect: (category: CatalogCategory) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.grid}>
      {categories.map((category) => {
        const count = counts[category] ?? 0;
        return (
          <Card
            key={category}
            mode="outlined"
            style={styles.card}
            onPress={() => onSelect(category)}
            accessibilityLabel={CATALOG_CATEGORY_LABELS[category]}
          >
            <Card.Content style={styles.cardContent}>
              <View
                style={[styles.iconBadge, { backgroundColor: theme.colors.secondaryContainer }]}
              >
                <MaterialCommunityIcons
                  name={CATEGORY_ICONS[category]}
                  size={26}
                  color={theme.colors.onSecondaryContainer}
                />
              </View>
              <Text variant="titleMedium">{CATALOG_CATEGORY_LABELS[category]}</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {countLabel(count)}
              </Text>
            </Card.Content>
          </Card>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingTop: 4,
    gap: 10,
  },
  // Two columns: half the row minus half the gap.
  card: { flexBasis: '48%', flexGrow: 1 },
  cardContent: { alignItems: 'flex-start', gap: 4, paddingVertical: 14 },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
});
