import { formatDistanceShort } from '@core/catalog/exploreFormat';
import { TRAIL_ACTIVITY_LABELS, trailListMeta } from '@core/trails/format';
import {
  groupTrails,
  matchesActivity,
  TRAIL_SORT_LABELS,
  TRAIL_SORTS,
  type RankedTrail,
  type TrailGroup,
  type TrailSort,
} from '@core/trails/rank';
import { TRAIL_ACTIVITIES, type TrailActivity } from '@core/trails/schema';
import { useLongTrailsStore } from '@state/longTrailsStore';
import { useSettingsStore } from '@state/settingsStore';
import { HeaderContours } from '@ui/components/ContourTexture';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { ScreenHeader } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, SectionList, StyleSheet, View } from 'react-native';
import { Button, Menu, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilterChip } from '../explore/ExploreParts';
import { exploreTrailHref } from '../explore/exploreRoutes';
import { LongTrailRow } from './LongTrailParts';
import { useRankedTrails } from './useLongTrails';

/**
 * Every long-distance trail (#467, board `List.dc.html`): activity chips
 * (All / Hiking / Cycling / Skiing / Paddling), a sort (nearest first by
 * default), and sections — POPULAR NEAR YOU, then the user's continent by
 * country and the other continents whole (`@core/trails/rank.groupTrails`).
 */

type Section = TrailGroup & { data: RankedTrail[] };

const keyExtractor = (r: RankedTrail) => r.trail.id;

export function LongTrailsListScreen() {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const index = useLongTrailsStore((s) => s.index);
  const load = useLongTrailsStore((s) => s.load);
  const { status, ranked, origin } = useRankedTrails();
  const [activity, setActivity] = useState<TrailActivity | null>(null);
  const [sort, setSort] = useState<TrailSort>(origin !== null ? 'nearest' : 'popular');
  const [sortOpen, setSortOpen] = useState(false);

  const present = useMemo(
    () => TRAIL_ACTIVITIES.filter((a) => ranked.some((r) => r.trail.activities.includes(a))),
    [ranked],
  );
  const sections: Section[] = useMemo(() => {
    if (index === null) return [];
    const pool = ranked.filter((r) => matchesActivity(r.trail, activity));
    return groupTrails(pool, index, sort).map((g) => ({ ...g, data: g.entries }));
  }, [ranked, index, activity, sort]);

  const renderItem = useCallback(
    ({ item: { trail, distanceM } }: { item: RankedTrail }) => (
      <LongTrailRow
        trail={trail}
        title={trail.name}
        meta={index === null ? '' : trailListMeta(trail, index.countries, units)}
        distance={distanceM === null ? null : formatDistanceShort(distanceM, units)}
        onPress={() => router.push(exploreTrailHref(trail.id))}
      />
    ),
    [index, units, router],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: Section }) => (
      <Text
        accessibilityRole="header"
        style={[styles.sectionTitle, { color: t.inkMuted, backgroundColor: t.background }]}
      >
        {section.title}
      </Text>
    ),
    [t],
  );

  const header = (
    <View style={{ paddingTop: insets.top }}>
      <ScreenHeader title="Long-distance trails" onBack={() => router.back()} />
    </View>
  );

  if (status !== 'ready' || index === null) {
    return (
      <View style={[styles.fill, { backgroundColor: t.background }]}>
        <HeaderContours />
        {header}
        <View style={styles.empty}>
          {status === 'unavailable' ? (
            <>
              <Text variant="bodyMedium" style={[styles.center, { color: t.inkVariant }]}>
                The trail list isn’t available right now. Check your connection and try again.
              </Text>
              <Button mode="contained-tonal" onPress={() => void load(true)}>
                Retry
              </Button>
            </>
          ) : (
            <InukshukLoader />
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <HeaderContours />
      {header}
      <SectionList
        sections={sections}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        stickySectionHeadersEnabled={false}
        initialNumToRender={14}
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
        ListHeaderComponent={
          <View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              <FilterChip label="All" on={activity === null} onPress={() => setActivity(null)} />
              {present.map((a) => (
                <FilterChip
                  key={a}
                  label={TRAIL_ACTIVITY_LABELS[a]}
                  on={activity === a}
                  onPress={() => setActivity(activity === a ? null : a)}
                />
              ))}
            </ScrollView>
            <View style={styles.sortRow}>
              <Menu
                visible={sortOpen}
                onDismiss={() => setSortOpen(false)}
                anchor={
                  <FilterChip
                    label={TRAIL_SORT_LABELS[sort]}
                    icon="chevron-down"
                    accessibilityLabel={`Sort: ${TRAIL_SORT_LABELS[sort]}`}
                    on={false}
                    onPress={() => setSortOpen(true)}
                  />
                }
              >
                {TRAIL_SORTS.filter((s) => s !== 'nearest' || origin !== null).map((s) => (
                  <Menu.Item
                    key={s}
                    title={TRAIL_SORT_LABELS[s]}
                    leadingIcon={s === sort ? 'check' : undefined}
                    onPress={() => {
                      setSort(s);
                      setSortOpen(false);
                    }}
                  />
                ))}
              </Menu>
            </View>
          </View>
        }
        ListEmptyComponent={
          <Text variant="bodyMedium" style={[styles.center, styles.none, { color: t.inkVariant }]}>
            No trails for this activity yet.
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { textAlign: 'center' },
  empty: { alignItems: 'center', gap: 12, paddingTop: 64, paddingHorizontal: 24 },
  none: { paddingTop: 48, paddingHorizontal: 24 },
  chips: { gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.xs },
  sortRow: { flexDirection: 'row', paddingHorizontal: space.lg },
  sectionTitle: {
    paddingTop: space.lg,
    paddingBottom: 6,
    paddingHorizontal: space.lg,
    fontSize: 12.5,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
});
