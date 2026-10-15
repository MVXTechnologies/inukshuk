/**
 * `/team/sos/<owner>/<id>` and `/team/rally/<owner>/<id>` (an SOS or rally
 * notification's link, #708): centre the main map on it — an SOS on its
 * raiser's live position — and leave. Its band on the map carries Navigate.
 */
import { useTeamStore, type TeamSnapshot } from '@state/teamStore';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useTeamMapFocus } from './teamMapFocus';

export function TeamAlertRoute({ kind }: { kind: 'sos' | 'rally' }) {
  const router = useRouter();
  const { owner, id } = useLocalSearchParams<{ owner: string; id: string }>();
  // One number per selector: a fresh tuple would re-render for ever.
  const lng = useTeamStore((s) => where(s, kind, owner, id)?.[0]);
  const lat = useTeamStore((s) => where(s, kind, owner, id)?.[1]);
  useEffect(() => {
    if (lng !== undefined && lat !== undefined) useTeamMapFocus.getState().focus(lng, lat, 16);
    router.replace('/');
  }, [lng, lat, router]);
  return null;
}

/** Where the alert is, `[lng, lat]`, or undefined when it is gone. */
function where(
  s: Pick<TeamSnapshot, 'rally' | 'soses' | 'positions'>,
  kind: 'sos' | 'rally',
  owner: string | undefined,
  id: string | undefined,
): [number, number] | undefined {
  if (kind === 'rally') {
    const r = s.rally;
    return r && r.owner === owner && r.id === id ? [r.lng, r.lat] : undefined;
  }
  const sos = s.soses.find((x) => x.owner === owner && x.id === id);
  if (!sos) return undefined;
  const live = s.positions.find((p) => p.id === owner);
  return live ? [live.lon, live.lat] : [sos.lng, sos.lat];
}
