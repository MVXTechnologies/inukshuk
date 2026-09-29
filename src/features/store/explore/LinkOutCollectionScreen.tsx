import { formatDistanceShort } from '@core/catalog/exploreFormat';
import {
  placeTypes,
  pluralPlaceType,
  sortLinkOutPlaces,
  type PlaceEntry,
} from '@core/catalog/linkOutPlaces';
import { CATALOG_ACTIVITY_LABELS } from '@core/catalog/taxonomy';
import { useSettingsStore } from '@state/settingsStore';
import { HeaderContours } from '@ui/components/ContourTexture';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { ScreenHeader } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilterChip } from './ExploreParts';
import { useLinkOutCollections } from './useLinkOutCollections';

/**
 * A link-out collection (#447, board `Collection.dc.html` — Parcs Québec):
 * places whose maps live on the publisher's own site. SÉPAQ's maps are
 * copyrighted and sepaq.com refuses scripted downloads, so there is no
 * Download here and nothing is fetched from them: each row opens the park's
 * page in the browser, and the user opens the PDF with Inukshuk from there.
 *
 * Sort chips: Nearest first (every place), then one chip per place type
 * ("National parks", "Wildlife reserves") — each nearest-first.
 */

const keyExtractor = (entry: PlaceEntry) => entry.place.id;

export function LinkOutCollectionScreen({ id }: { id: string }) {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const units = useSettingsStore((s) => s.units);
  const { status, collections } = useLinkOutCollections();
  const collection = collections.find((c) => c.id === id);
  const [type, setType] = useState<string | null>(null);

  const types = useMemo(() => (collection ? placeTypes(collection.places) : []), [collection]);
  const entries = useMemo(
    () => (collection ? sortLinkOutPlaces(collection.places, position, type) : []),
    [collection, position, type],
  );

  const renderItem = useCallback(
    ({ item: { place, distanceMeters } }: { item: PlaceEntry }) => {
      const activities = (place.activities ?? [])
        .map((a) => CATALOG_ACTIVITY_LABELS[a].toLowerCase())
        .join(', ');
      const meta = activities !== '' ? `${place.type} · ${activities}` : place.type;
      const distance = distanceMeters !== null ? formatDistanceShort(distanceMeters, units) : null;
      return (
        <Pressable
          onPress={() => void Linking.openURL(place.url)}
          accessibilityRole="link"
          accessibilityLabel={[place.name, meta, distance].filter(Boolean).join(', ')}
          accessibilityHint="Opens the park's maps on the publisher's website"
          style={({ pressed }) => [
            styles.place,
            { backgroundColor: t.surface, borderColor: t.outlineVariant },
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.placeText}>
            <Text style={[styles.placeName, { color: t.ink }]}>{place.name}</Text>
            <Text style={[styles.placeMeta, { color: t.inkMuted }]}>{meta}</Text>
          </View>
          {distance !== null && (
            <Text style={[styles.distance, { color: t.explore.accent }]}>{distance}</Text>
          )}
          <Icon source="open-in-new" size={18} color={t.inkMuted} />
        </Pressable>
      );
    },
    [t, units],
  );

  const header = (
    <View style={{ paddingTop: insets.top }}>
      <ScreenHeader title={collection?.name ?? 'Collection'} onBack={() => router.back()} />
    </View>
  );

  if (collection === undefined) {
    return (
      <View style={[styles.fill, { backgroundColor: t.background }]}>
        <HeaderContours />
        {header}
        <View style={styles.missing}>
          {status === 'loading' ? (
            <InukshukLoader />
          ) : (
            <Text variant="bodyMedium" style={[styles.center, { color: t.inkVariant }]}>
              This collection isn’t available right now.
            </Text>
          )}
        </View>
      </View>
    );
  }

  const host = /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(collection.homepage)?.[1];
  const intro = `${collection.publisher}’s park maps are published on ${
    host ?? 'their website'
  }. Tap a park to open its maps there, then open the PDF with Inukshuk.`;

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <HeaderContours />
      {header}
      <FlatList
        data={entries}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.xl }]}
        ListHeaderComponent={
          <View>
            <Text style={[styles.intro, { color: t.inkVariant }]}>{intro}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              <FilterChip
                label={position !== null ? 'Nearest first' : 'A to Z'}
                on={type === null}
                onPress={() => setType(null)}
              />
              {types.length > 1 &&
                types.map((value) => (
                  <FilterChip
                    key={value}
                    label={pluralPlaceType(value)}
                    on={type === value}
                    onPress={() => setType(type === value ? null : value)}
                  />
                ))}
            </ScrollView>
          </View>
        }
        ItemSeparatorComponent={Gap}
        initialNumToRender={12}
      />
    </View>
  );
}

function Gap() {
  return <View style={styles.gap} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { textAlign: 'center' },
  missing: { alignItems: 'center', paddingTop: 64, paddingHorizontal: 24 },
  pressed: { opacity: 0.85 },
  list: { paddingHorizontal: space.lg },
  intro: { marginTop: space.xs, fontSize: 14, lineHeight: 20 },
  chips: { gap: space.sm, paddingVertical: space.xs },
  gap: { height: space.sm },
  place: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  placeText: { flex: 1, minWidth: 0, gap: 2 },
  placeName: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  placeMeta: { fontSize: 13, lineHeight: 18 },
  distance: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
});
