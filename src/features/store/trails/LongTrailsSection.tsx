import { formatDistanceShort } from '@core/catalog/exploreFormat';
import { trailCardMeta } from '@core/trails/format';
import { trailsNearYou } from '@core/trails/rank';
import { useSettingsStore } from '@state/settingsStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Text } from 'react-native-paper';

import { SectionHeading } from '../explore/ExploreParts';
import { exploreTrailHref, exploreTrailsHref } from '../explore/exploreRoutes';
import { LongTrailCard } from './LongTrailParts';
import { useRankedTrails } from './useLongTrails';

/**
 * Explore's "Long-distance trails near you" (#467, board `Main.dc.html`): the
 * most popular waymarked routes around the user (`@core/trails/rank` mixes
 * popularity and distance), a carousel of drawn trail cards, and "See all".
 *
 * Renders nothing until the trail index is in — before the data is deployed,
 * offline on a first launch, or while it loads — so the landing never shows a
 * dead section.
 */
export function LongTrailsSection() {
  const t = useSchemeTokens();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const { status, ranked, origin } = useRankedTrails();
  const near = useMemo(() => trailsNearYou(ranked), [ranked]);

  if (status !== 'ready' || near.length === 0) return null;

  return (
    <>
      <SectionHeading
        title={origin !== null ? 'Long-distance trails near you' : 'Popular long-distance trails'}
        action={{
          label: 'See all',
          accessibilityLabel: 'See all long-distance trails',
          onPress: () => router.push(exploreTrailsHref()),
        }}
      />
      <Text style={[styles.blurb, { color: t.inkMuted }]}>
        {origin !== null
          ? 'The most popular waymarked routes around you, from a weekend to a season.'
          : 'The most popular waymarked routes, from a weekend to a season.'}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.carousel}
        accessibilityLabel="Long-distance trails near you"
      >
        {near.map(({ trail, distanceM }) => (
          <LongTrailCard
            key={trail.id}
            trail={trail}
            title={trail.name}
            meta={trailCardMeta(trail, units)}
            distance={
              distanceM === null
                ? null
                : distanceM < 1000
                  ? 'On the trail'
                  : `${formatDistanceShort(distanceM, units)} away`
            }
            onPress={() => router.push(exploreTrailHref(trail.id))}
          />
        ))}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  blurb: {
    marginTop: -6,
    marginBottom: space.md,
    paddingHorizontal: space.lg,
    fontSize: 14,
    lineHeight: 19,
  },
  carousel: { paddingHorizontal: space.lg, gap: space.md },
});
