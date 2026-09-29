import { LinkOutCollectionScreen } from '@features/store/explore/LinkOutCollectionScreen';
import { useLocalSearchParams } from 'expo-router';

/** Explore › a link-out collection (Parcs Québec: rows open sepaq.com) — #447. */
export default function ExploreCollectionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <LinkOutCollectionScreen id={id ?? ''} />;
}
