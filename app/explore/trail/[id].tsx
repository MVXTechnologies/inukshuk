import { LongTrailScreen } from '@features/store/trails/LongTrailScreen';
import { useLocalSearchParams } from 'expo-router';

/** Explore › one long-distance trail's page — #467. */
export default function ExploreTrailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <LongTrailScreen id={id ?? ''} />;
}
