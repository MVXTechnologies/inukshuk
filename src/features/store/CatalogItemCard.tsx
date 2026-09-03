import type { InstallStatus } from '@core/catalog/installStatus';
import type { CatalogItem, CatalogSource } from '@core/catalog/schema';
import { formatByteSize } from '@core/storage/diskBudget';
import { formatDistance } from '@state/formatters';
import { Linking, StyleSheet, View } from 'react-native';
import { Button, Card, IconButton, ProgressBar, Text, useTheme } from 'react-native-paper';

import { LocatorThumb } from './LocatorThumb';

/**
 * One catalog row — locator thumbnail, title, meta line, and the single action
 * the item's install state calls for. Shared by the category list and the
 * "Around you" section on the landing, so a nearby chart offers exactly the
 * same Download/Open/Update affordance wherever it is surfaced.
 */

/** "≈ 12 km" caption: standard distance formatting minus noise decimals. */
export function approxDistanceLabel(meters: number): string {
  const clean = formatDistance(meters)
    .replace(/(\.\d*?)0+(?=\s)/, '$1')
    .replace(/\.(?=\s)/, '');
  return `≈ ${clean}`;
}

/** Coverage line, hemisphere-correct for a worldwide catalog. */
function coverageLabel(bbox: readonly [number, number, number, number]): string {
  const lat = (value: number) => `${Math.abs(value).toFixed(2)}°${value < 0 ? 'S' : 'N'}`;
  const lon = (value: number) => `${Math.abs(value).toFixed(2)}°${value < 0 ? 'W' : 'E'}`;
  return `${lat(bbox[1])}–${lat(bbox[3])}, ${lon(bbox[0])}–${lon(bbox[2])}`;
}

export interface CatalogItemCardProps {
  item: CatalogItem;
  source?: CatalogSource | undefined;
  installStatus: InstallStatus;
  /** Download progress 0..1, null for indeterminate, undefined when idle. */
  progress?: number | null | undefined;
  downloading: boolean;
  expanded: boolean;
  /** Metres to the user, when a position is known. */
  distanceMeters?: number | null | undefined;
  onToggleExpand: () => void;
  onDownload: () => void;
  onUpdate: () => void;
  onOpen: () => void;
  onCancel: () => void;
}

export function CatalogItemCard({
  item,
  source,
  installStatus,
  progress,
  downloading,
  expanded,
  distanceMeters,
  onToggleExpand,
  onDownload,
  onUpdate,
  onOpen,
  onCancel,
}: CatalogItemCardProps) {
  const theme = useTheme();

  const meta = [
    distanceMeters != null ? approxDistanceLabel(distanceMeters) : undefined,
    source?.name,
    item.sizeBytes !== undefined ? formatByteSize(item.sizeBytes) : undefined,
    item.updatedAt,
    item.lang?.toUpperCase(),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  const action = downloading ? (
    <IconButton
      icon="close-circle-outline"
      accessibilityLabel={`Cancel download of ${item.title}`}
      onPress={onCancel}
    />
  ) : installStatus === 'installed' ? (
    <Button compact onPress={onOpen}>
      Open
    </Button>
  ) : installStatus === 'update-available' ? (
    <Button compact mode="contained-tonal" onPress={onUpdate}>
      Update
    </Button>
  ) : (
    <Button compact mode="contained-tonal" onPress={onDownload}>
      Download
    </Button>
  );

  return (
    <Card mode="outlined" style={styles.card} onPress={onToggleExpand}>
      <Card.Content>
        <View style={styles.cardRow}>
          <LocatorThumb bbox={item.bbox} size={56} />
          <View style={styles.cardText}>
            <Text variant="titleSmall">{item.title}</Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {meta}
            </Text>
          </View>
          {action}
        </View>
        {downloading && (
          <ProgressBar
            style={styles.progress}
            progress={progress ?? 0}
            indeterminate={progress === null || progress === undefined}
          />
        )}
        {expanded && (
          <View style={styles.details}>
            {source !== undefined && (
              <Text variant="bodySmall">
                {source.attribution} — {source.licence}
              </Text>
            )}
            {item.region !== undefined && <Text variant="bodySmall">Region: {item.region}</Text>}
            {item.bbox !== undefined && (
              <Text variant="bodySmall">Coverage: {coverageLabel(item.bbox)}</Text>
            )}
            {source?.homepage !== undefined && (
              <Button
                compact
                icon="open-in-new"
                style={styles.sourceLink}
                onPress={() => void Linking.openURL(source.homepage ?? '')}
              >
                About this source
              </Button>
            )}
          </View>
        )}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 0 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardText: { flex: 1 },
  progress: { marginTop: 8, height: 5, borderRadius: 3 },
  details: { marginTop: 10, gap: 3 },
  sourceLink: { alignSelf: 'flex-start', marginTop: 4 },
});
