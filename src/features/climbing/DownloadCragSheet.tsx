import { routesLabel } from '@core/climbing/card';
import type { CragSummary } from '@core/climbing/crag';
import { CRAG_MAP_MARGIN_M, CRAG_MAP_ZOOMS } from '@core/climbing/saved';
import { formatBytes } from '@core/format';
import { useClimbingStore } from '@state/climbingStore';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Checkbox, Icon, ProgressBar, Text } from 'react-native-paper';

/** About 25 bytes a route once compressed; shown as at least 1 KB. */
function topoBytes(routes: number): number {
  return Math.max(1024, routes * 25);
}

/**
 * "Download {crag} for offline" (mockups 04 and 04b): what a download holds —
 * the routes & diagrams (always), the crag & approach map (2 km, z12–16, a
 * few MB; can be left out), photo topos (none with an open licence yet) —
 * then the progress. A plain view in the sheet, never a Portal dialog (an
 * invisible overlay soft-locks the screen with animations off).
 */
export function DownloadCragSheet({
  crag,
  mapBytes,
  onConfirm,
  onCancel,
}: {
  crag: CragSummary;
  mapBytes: number;
  onConfirm: (withMap: boolean) => void;
  onCancel: () => void;
}) {
  const t = useSchemeTokens();
  const [withMap, setWithMap] = useState(true);
  const download = useClimbingStore((s) => s.downloads[crag.uid]);
  const total = topoBytes(crag.routes) + (withMap ? mapBytes : 0);
  const km = CRAG_MAP_MARGIN_M / 1000;

  if (download) {
    const mapDone = download.phase === 'map' ? download.pct / 100 : 0;
    return (
      <View style={styles.sheet} testID="crag-download-progress">
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          {`Downloading ${crag.name}`}
        </Text>
        <Text style={[styles.body, { color: t.inkVariant }]}>
          You can leave this screen. The topo works offline once it is done.
        </Text>
        {download.phase === 'map' && (
          <>
            <Text style={[styles.small, { color: t.inkMuted }]}>
              {`Map of the crag and approach · ${formatBytes(download.bytes)} of ${formatBytes(download.expectedBytes)}`}
            </Text>
            <ProgressBar progress={mapDone} color={t.explore.accent} />
          </>
        )}
        <Item
          icon={download.phase === 'map' ? 'check-circle' : 'progress-download'}
          title="Routes & diagrams"
          detail={`${routesLabel(crag.routes)} in ${crag.sectors} ${crag.sectors === 1 ? 'sector' : 'sectors'}`}
          size={formatBytes(topoBytes(crag.routes))}
        />
        <Item
          icon="map-outline"
          title="Map of the crag & approach"
          detail={`Base map, contours and trails · zoom ${CRAG_MAP_ZOOMS.min}–${CRAG_MAP_ZOOMS.max}`}
          size={formatBytes(download.expectedBytes || mapBytes)}
        />
      </View>
    );
  }

  return (
    <View style={styles.sheet} testID="crag-download-confirm">
      <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
        {`Download ${crag.name} for offline`}
      </Text>
      <Text style={[styles.body, { color: t.inkVariant }]}>
        Everything you need at the crag with no signal: the routes, the diagrams and the map to get
        there.
      </Text>
      <Item
        icon="format-list-numbered"
        title="Routes & diagrams"
        detail={`${routesLabel(crag.routes)} in ${crag.sectors} ${crag.sectors === 1 ? 'sector' : 'sectors'} · grades, style`}
        size={formatBytes(topoBytes(crag.routes))}
        checked
      />
      <Item
        icon="map-outline"
        title="Map of the crag & approach"
        detail={`Base map, contours and trails · ${km} km around · zoom ${CRAG_MAP_ZOOMS.min}–${CRAG_MAP_ZOOMS.max}`}
        size={formatBytes(mapBytes)}
        checked={withMap}
        onToggle={() => setWithMap((v) => !v)}
      />
      <Item
        icon="image-outline"
        title="Photo topos"
        detail="None with an open licence yet. Attach your own from the topo."
        disabled
      />
      <Item
        icon="folder-outline"
        title="Show in Library › Climbing"
        detail="Downloaded crags also appear on your main map"
      />
      <View style={styles.actions}>
        <Pressable
          onPress={() => onConfirm(withMap)}
          accessibilityRole="button"
          style={[styles.primary, { backgroundColor: t.library.chipOn }]}
          testID="crag-download-confirm-button"
        >
          <Icon source="download" size={20} color={t.library.chipOnInk} />
          <Text style={[styles.primaryText, { color: t.library.chipOnInk }]}>
            {`Download · ${formatBytes(total)}`}
          </Text>
        </Pressable>
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          style={[styles.secondary, { borderColor: t.outlineVariant }]}
        >
          <Text style={[styles.primaryText, { color: t.ink }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Item({
  icon,
  title,
  detail,
  size,
  checked,
  disabled,
  onToggle,
}: {
  icon: string;
  title: string;
  detail: string;
  size?: string;
  checked?: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}) {
  const t = useSchemeTokens();
  const body = (
    <View style={[styles.item, disabled && styles.dim]}>
      <Icon source={icon} size={22} color={t.inkVariant} />
      <View style={styles.itemText}>
        <Text style={[styles.itemTitle, { color: t.ink }]}>{title}</Text>
        <Text style={[styles.small, { color: t.inkMuted }]}>{detail}</Text>
      </View>
      {size !== undefined && <Text style={[styles.size, { color: t.inkVariant }]}>{size}</Text>}
      {checked !== undefined && (
        <Checkbox.Android
          status={checked ? 'checked' : 'unchecked'}
          disabled={onToggle === undefined || disabled}
          onPress={onToggle}
        />
      )}
    </View>
  );
  return onToggle ? (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: checked === true }}
      accessibilityLabel={title}
    >
      {body}
    </Pressable>
  ) : (
    body
  );
}

const styles = StyleSheet.create({
  sheet: { gap: space.md },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '800' },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48 },
  dim: { opacity: 0.6 },
  itemText: { flex: 1, minWidth: 0, gap: 2 },
  itemTitle: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  size: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: space.sm, alignItems: 'center', marginTop: space.xs },
  primary: {
    flex: 1,
    minHeight: target.min,
    borderRadius: target.min / 2,
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  secondary: {
    minHeight: target.min,
    paddingHorizontal: space.lg,
    borderRadius: target.min / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
