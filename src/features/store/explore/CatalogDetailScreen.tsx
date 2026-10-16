import { itemCredit, sourceFreeLine } from '@core/catalog/credit';
import { formatMapScale } from '@core/catalog/exploreFacets';
import { formatDistanceShort } from '@core/catalog/exploreFormat';
import { installStatusFor, NEWER_VERSION_NOTICE } from '@core/catalog/installStatus';
import { catalogItemDistanceMeters } from '@core/catalog/nearest';
import type { CatalogItem, CatalogSource } from '@core/catalog/schema';
import {
  CATALOG_ACTIVITY_LABELS,
  CATALOG_KIND_LABELS,
  CATALOG_TERRAIN_LABELS,
} from '@core/catalog/taxonomy';
import { formatByteSize } from '@core/storage/diskBudget';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { ScreenHeader } from '@ui/components/ScreenHeader';
import { radius, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Icon, ProgressBar, Text } from '@ui/paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CoverageMap, coverageText } from './CoverageMap';
import { ExploreStat, MapPreview, TagChip } from './ExploreParts';
import { itemFacets, itemScaleDenominator } from './facetsAdapter';
import { useCatalogDownloadFlow } from './useCatalogDownloadFlow';
import { openExternalLink } from '@lib/openLink';
import { useCreditLanguage } from '../useCreditLanguage';
import { useScaledStyles } from '@ui/displayScale';

/**
 * One map's detail page (#447, board `Detail.dc.html`): preview (the
 * publisher's thumbnail or a drawn placeholder), kind/activity/terrain tags,
 * title, publisher and sheet id, stat tiles (scale, download size, distance),
 * the offline coverage mini-map with the user's position, format / updated /
 * licence / source rows, and the one primary action the install state calls
 * for — **Download · Free**, **Open on map**, or **Update** — through the
 * store's existing download flow (folder dialog, progress, cancel).
 *
 * Reads the item out of the loaded catalog; a deep link to one that is not
 * loaded says so instead of guessing.
 */

const PREVIEW_HEIGHT = 300;

function hostOf(url: string): string {
  const match = /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(url);
  return match?.[1] ?? url;
}

function formatLabel(item: CatalogItem): string {
  return `${item.format === 'geopdf' ? 'GeoPDF' : 'PDF'} · works offline`;
}

export function CatalogDetailScreen({ id }: { id: string }) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const flow = useCatalogDownloadFlow();
  const creditLang = useCreditLanguage();

  const status = useCatalogStore((s) => s.status);
  const index = useCatalogStore((s) => s.index);
  const load = useCatalogStore((s) => s.load);
  const item = useCatalogStore((s) => s.items.find((i) => i.id === id));
  const progress = useCatalogStore((s) => s.downloads[id]);
  const downloading = useCatalogStore((s) => id in s.downloads);
  const maps = useLibraryStore((s) => s.maps);
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const units = useSettingsStore((s) => s.units);

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  const source: CatalogSource | undefined = useMemo(
    () => (item === undefined ? undefined : index?.sources.find((s) => s.id === item.sourceId)),
    [index, item],
  );

  if (item === undefined) {
    return (
      <View style={[styles.fill, { backgroundColor: t.background, paddingTop: insets.top }]}>
        <ScreenHeader title="Map" onBack={() => router.back()} />
        <View style={styles.missing}>
          {status === 'idle' || status === 'loading' ? (
            <InukshukLoader />
          ) : (
            <Text variant="bodyMedium" style={[styles.center, { color: t.inkVariant }]}>
              This map isn’t in the part of the catalog loaded right now.
            </Text>
          )}
        </View>
      </View>
    );
  }

  const facets = itemFacets(item);
  const scale = itemScaleDenominator(item);
  const distance = position !== null ? catalogItemDistanceMeters(item, position) : null;
  const installStatus = installStatusFor(item, maps);
  const stats = [
    scale !== null ? { value: formatMapScale(scale), label: 'Scale' } : null,
    item.sizeBytes !== undefined
      ? { value: formatByteSize(item.sizeBytes), label: 'Download' }
      : null,
    distance !== null ? { value: formatDistanceShort(distance, units), label: 'From you' } : null,
  ].filter((s): s is { value: string; label: string } => s !== null);

  // A credited map (#680): its author leads, and the publisher's terms want
  // the "free at" line on the page. A plain PDF opens as a document.
  const credit = itemCredit(item);
  const freeLine = sourceFreeLine(source, creditLang);
  const freeUrl = item.pageUrl ?? source?.homepage;
  const plainPdf = item.format === 'pdf';
  const openLabel = plainPdf ? 'Open PDF' : 'Open on map';
  // A bbox taken from the river's name or the region is not the sheet's extent.
  const coverageLabel =
    item.bboxPrecision === 'river'
      ? 'Approximate area (the river)'
      : item.bboxPrecision === 'region'
        ? 'Approximate area (the region)'
        : 'Coverage';

  // `a11y`: the link's spoken label, when "Open " + the value does not read right.
  const rows: { label: string; value: string; url?: string; a11y?: string }[] = [
    ...(item.author !== undefined ? [{ label: 'Author', value: item.author }] : []),
    ...(item.year !== undefined ? [{ label: 'Year', value: String(item.year) }] : []),
    { label: 'Format', value: formatLabel(item) },
    ...(plainPdf ? [{ label: 'On the map', value: 'Not placed yet' }] : []),
    ...(item.updatedAt !== undefined ? [{ label: 'Updated', value: item.updatedAt }] : []),
    ...(source !== undefined ? [{ label: 'Licence', value: source.licence }] : []),
    ...(item.pageUrl !== undefined
      ? [
          {
            label: 'Map page',
            value: `On ${hostOf(item.pageUrl)}`,
            url: item.pageUrl,
            a11y: `Open on ${hostOf(item.pageUrl)}`,
          },
        ]
      : []),
    ...(source?.homepage !== undefined
      ? [{ label: 'Source', value: hostOf(source.homepage), url: source.homepage }]
      : []),
  ];

  const primary = downloading
    ? null
    : installStatus === 'installed'
      ? { label: openLabel, onPress: () => flow.open(item) }
      : installStatus === 'update-available'
        ? { label: 'Update', onPress: () => flow.update(item) }
        : { label: 'Download · Free', onPress: () => flow.requestDownload(item) };

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        <View style={{ height: PREVIEW_HEIGHT }}>
          <MapPreview
            thumbnailUrl={item.thumbnailUrl}
            seed={item.id}
            width={width}
            height={PREVIEW_HEIGHT}
          />
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={2}
            style={[styles.back, { top: insets.top + space.sm, backgroundColor: t.surface }]}
          >
            <Icon source="arrow-left" size={22} color={t.ink} />
          </Pressable>
        </View>

        <View style={styles.head}>
          <View style={styles.tags}>
            {facets.kind !== null && <TagChip label={CATALOG_KIND_LABELS[facets.kind]} strong />}
            {facets.activities.map((a) => (
              <TagChip key={a} label={CATALOG_ACTIVITY_LABELS[a]} />
            ))}
            {facets.terrain.map((v) => (
              <TagChip key={v} label={CATALOG_TERRAIN_LABELS[v]} />
            ))}
          </View>
          <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
            {item.title}
          </Text>
          <Text style={[styles.publisher, { color: t.inkMuted }]}>
            {credit !== undefined
              ? [credit, source?.name].filter(Boolean).join(' · ')
              : [source?.attribution ?? source?.name, item.id].filter(Boolean).join(' · ')}
          </Text>
          {freeLine !== undefined &&
            (freeUrl !== undefined ? (
              <Pressable
                onPress={() => void openExternalLink(freeUrl)}
                accessibilityRole="link"
                hitSlop={target.compactHitSlop}
                style={styles.freeLink}
              >
                <Text style={[styles.free, { color: t.explore.accent }]}>{freeLine}</Text>
              </Pressable>
            ) : (
              <Text style={[styles.free, { color: t.ink }]}>{freeLine}</Text>
            ))}
        </View>

        {stats.length > 0 && (
          <View style={styles.stats}>
            {stats.map((s) => (
              <ExploreStat key={s.label} value={s.value} label={s.label} />
            ))}
          </View>
        )}

        {item.bbox !== undefined && (
          <View
            style={[styles.coverage, { backgroundColor: t.surface, borderColor: t.outlineVariant }]}
            accessible
            accessibilityLabel={`${coverageLabel}. ${coverageText(item.bbox)}`}
          >
            <CoverageMap bbox={item.bbox} position={position} height={150} />
            <Text style={[styles.coverageText, { color: t.inkMuted }]}>
              {coverageLabel} · {coverageText(item.bbox)}
            </Text>
          </View>
        )}

        <View style={styles.rows}>
          {rows.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={[styles.rowLabel, { color: t.inkMuted }]}>{row.label}</Text>
              {row.url !== undefined ? (
                <Pressable
                  onPress={() => void openExternalLink(row.url ?? '')}
                  accessibilityRole="link"
                  accessibilityLabel={row.a11y ?? `Open ${row.value}`}
                  hitSlop={target.compactHitSlop}
                  style={styles.rowLink}
                >
                  <Text style={[styles.rowValue, { color: t.explore.accent }]}>{row.value}</Text>
                </Pressable>
              ) : (
                <Text style={[styles.rowValue, { color: t.ink }]}>{row.value}</Text>
              )}
            </View>
          ))}
        </View>

        <View style={styles.actions}>
          {installStatus === 'update-available' && !downloading && (
            <Text style={[styles.newer, { color: t.ink }]}>{NEWER_VERSION_NOTICE}</Text>
          )}
          {downloading ? (
            <View style={styles.progressWrap}>
              <ProgressBar
                progress={progress ?? 0}
                indeterminate={progress === null || progress === undefined}
                style={styles.progress}
              />
              <Pressable
                onPress={() => flow.cancel(item)}
                accessibilityRole="button"
                style={[styles.secondary, { borderColor: t.outline }]}
              >
                <Text style={[styles.secondaryText, { color: t.ink }]}>Cancel download</Text>
              </Pressable>
            </View>
          ) : (
            primary !== null && (
              <Pressable
                onPress={primary.onPress}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.primary,
                  { backgroundColor: t.library.chipOn },
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.primaryText, { color: t.library.chipOnInk }]}>
                  {primary.label}
                </Text>
              </Pressable>
            )
          )}
          {installStatus === 'update-available' && !downloading && (
            <Pressable
              onPress={() => flow.open(item)}
              accessibilityRole="button"
              style={[styles.secondary, { borderColor: t.outline }]}
            >
              <Text style={[styles.secondaryText, { color: t.ink }]}>{openLabel}</Text>
            </Pressable>
          )}
        </View>
        <Text style={[styles.footnote, { color: t.inkMuted }]}>
          {plainPdf
            ? 'Downloaded straight from the publisher, kept in your Library. Not placed on the map yet: it opens as a PDF, without your position.'
            : 'Downloaded straight from the publisher, kept in your Library, works without signal.'}
        </Text>
      </ScrollView>
      {flow.overlays}
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  fill: { flex: 1 },
  center: { textAlign: 'center' },
  missing: { alignItems: 'center', paddingTop: 64, paddingHorizontal: 24 },
  pressed: { opacity: 0.85 },
  back: {
    position: 'absolute',
    left: space.md,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  head: { paddingTop: 18, paddingHorizontal: space.lg, gap: 6 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  title: { marginTop: space.xs, fontSize: 24, lineHeight: 29, fontWeight: '800' },
  publisher: { fontSize: 14, lineHeight: 19 },
  freeLink: { alignSelf: 'flex-start' },
  newer: { textAlign: 'center', fontSize: 14, lineHeight: 19, fontWeight: '700' },
  free: { fontSize: 14, lineHeight: 19, fontWeight: '700' },
  stats: {
    marginTop: space.lg,
    marginHorizontal: space.lg,
    flexDirection: 'row',
    gap: space.sm,
  },
  coverage: {
    marginTop: space.lg,
    marginHorizontal: space.lg,
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  coverageText: { paddingHorizontal: 14, paddingVertical: 10, fontSize: 13, lineHeight: 18 },
  rows: { marginTop: space.lg, marginHorizontal: space.lg, gap: 10 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
    minHeight: 24,
  },
  rowLabel: { fontSize: 14, lineHeight: 19 },
  rowValue: { flexShrink: 1, textAlign: 'right', fontSize: 14, lineHeight: 19, fontWeight: '700' },
  rowLink: { flexShrink: 1 },
  actions: { marginTop: space.xl, marginHorizontal: space.lg, gap: 10 },
  primary: {
    minHeight: 54,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  primaryText: { fontSize: 17, lineHeight: 22, fontWeight: '800' },
  secondary: {
    minHeight: target.min,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  progressWrap: { gap: 10 },
  progress: { height: 6, borderRadius: 3 },
  footnote: {
    marginTop: 10,
    marginHorizontal: space.lg,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
  },
});
