import { ExploreListScreen } from '@features/store/explore/ExploreListScreen';
import { filterFromParams } from '@features/store/explore/exploreRoutes';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

/** Explore › a filtered list (an activity, a terrain, a publisher, a type) — #447. */
export default function ExploreListRoute() {
  const params = useLocalSearchParams();
  // Stable identity: the screen seeds its filter state from it once.
  const filter = useMemo(() => filterFromParams(params), [params]);
  return <ExploreListScreen initialFilter={filter} />;
}
