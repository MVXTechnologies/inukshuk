import type { AnchorLookup } from '@core/teamui/tasks';
import { useTeamStore } from '@state/teamStore';
import { useMemo } from 'react';

/** Task anchors resolved against the open team's photos, pins and trails. */
export function useAnchorLookup(): AnchorLookup {
  const photos = useTeamStore((s) => s.photos);
  const pins = useTeamStore((s) => s.pins);
  const tracks = useTeamStore((s) => s.shares.tracks);
  return useMemo(
    () => ({
      photo: (owner, id) => {
        const p = photos.find((x) => x.owner === owner && x.id === id);
        return p ? { lng: p.lng, lat: p.lat, caption: p.caption } : undefined;
      },
      pin: (owner, id) => {
        const p = pins.find((x) => x.owner === owner && x.id === id);
        return p ? { lng: p.lng, lat: p.lat, text: p.messages[0]?.text ?? '' } : undefined;
      },
      trail: (owner, id) => {
        const tr = tracks.find((x) => x.owner === owner && x.id === id);
        return tr ? { name: tr.name, start: tr.parts[0]?.[0] ?? null } : undefined;
      },
    }),
    [photos, pins, tracks],
  );
}
