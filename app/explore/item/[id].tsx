import { CatalogDetailScreen } from '@features/store/explore/CatalogDetailScreen';
import { useLocalSearchParams } from 'expo-router';

/** Explore › one map's detail page — #447. */
export default function ExploreItemRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <CatalogDetailScreen id={id ?? ''} />;
}
