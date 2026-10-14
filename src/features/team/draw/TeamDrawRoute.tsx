/**
 * `/team/draw/<author>` (a drawing notification's "Show on map"): frame the
 * author's shapes on the main map, or say they have all faded, and leave.
 */
import { useTeamDrawStore } from '@state/teamDrawStore';
import { useTeamStore } from '@state/teamStore';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { showAuthor } from './drawShared';

export function TeamDrawRoute() {
  const router = useRouter();
  const { owner } = useLocalSearchParams<{ owner: string }>();
  useEffect(() => {
    if (typeof owner === 'string' && !showAuthor(owner)) {
      const name =
        useTeamStore.getState().view?.members.find((m) => m.id === owner)?.name ?? 'A teammate';
      useTeamDrawStore.getState().announce(owner, name, true);
    }
    router.replace('/');
  }, [owner, router]);
  return null;
}
