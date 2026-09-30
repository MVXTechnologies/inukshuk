import { ExploreMapScreen } from '@features/store/explore/ExploreMapScreen';
import { filterFromParams, openedFromList } from '@features/store/explore/exploreRoutes';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

/** Explore › on a map: clustered catalog points and "Search this area" — #447. */
export default function ExploreMapRoute() {
  const params = useLocalSearchParams();
  const filter = useMemo(() => filterFromParams(params), [params]);
  return <ExploreMapScreen initialFilter={filter} fromList={openedFromList(params)} />;
}
