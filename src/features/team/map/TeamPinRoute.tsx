/**
 * `/team/pin/<owner>/<id>` (a pin notification's link): open the pin's card
 * on the main map, centred on it, and leave.
 */
import { useTeamStore } from '@state/teamStore';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useTeamMapFocus } from './teamMapFocus';
import { useTeamMapSelection } from './TeamMapOverlay';

export function TeamPinRoute() {
  const router = useRouter();
  const { owner, id } = useLocalSearchParams<{ owner: string; id: string }>();
  const pin = useTeamStore((s) => s.pins.find((p) => p.owner === owner && p.id === id));
  useEffect(() => {
    if (pin) {
      useTeamMapSelection.getState().select({ kind: 'pin', owner: pin.owner, id: pin.id });
      useTeamMapFocus.getState().focus(pin.lng, pin.lat);
    }
    router.replace('/');
  }, [pin, router]);
  return null;
}
