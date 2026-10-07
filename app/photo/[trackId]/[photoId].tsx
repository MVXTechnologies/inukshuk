import { PhotoViewerScreen } from '@features/photos/PhotoViewerScreen';
import { useLocalSearchParams } from 'expo-router';

export default function PhotoViewerRoute() {
  const { trackId, photoId } = useLocalSearchParams<{ trackId: string; photoId: string }>();
  return <PhotoViewerScreen trackId={trackId} photoId={photoId} />;
}
