import type { Href } from 'expo-router';

/** A crag's topo screen (`app/climbing/[uid].tsx`). */
export function cragHref(uid: string): Href {
  return { pathname: '/climbing/[uid]', params: { uid } };
}
