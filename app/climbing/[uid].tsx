import { CragTopoScreen } from '@features/climbing/CragTopoScreen';
import { useLocalSearchParams } from 'expo-router';

/** A crag's topo: sectors, the wall diagram or grade chart, the routes. */
export default function ClimbingCragRoute() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  return <CragTopoScreen uid={uid ?? ''} />;
}
