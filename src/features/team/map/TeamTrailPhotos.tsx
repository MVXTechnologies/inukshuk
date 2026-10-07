/**
 * Teammates' shared trail photos on the main map (#589 + #587, mockup
 * `a-map`): drawn by the trail-photo layers themselves (round GL sprites,
 * clustered stacks, the same look as my own photos). Each synced thumbnail
 * (`tb`) is written to a file once and turned into a round sprite by the
 * app's photo resizer, one at a time. My own trails that the map already
 * draws with their photos are left out (no double circles).
 */
import type { TrackPhoto } from '@core/photos/model';
import type { TeamPhoto } from '@core/teamui/comments';
import {
  teamPhotoFileExists,
  teamPhotoPaths,
  teamPhotoUri,
  writeTeamPhotoFile,
} from '@data/team/teamPhotoFiles';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { photoResizer } from '@features/photos/photoResizer';
import { usePhotoCard } from '@features/photos/PhotoBottomCard';
import { TrailPhotoLayers } from '@features/photos/TrailPhotoLayers';
import { useTeamStore } from '@state/teamStore';
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';

const MAX_TEAM_PHOTOS = 150;

const useSprites = create<{ ready: Record<string, true>; mark: (key: string) => void }>((set) => ({
  ready: {},
  mark: (key) => set((s) => ({ ready: { ...s.ready, [key]: true } })),
}));

let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

/** Make a photo's thumbnail and sprite files (once, in turn with the others). */
function ensureSprite(teamId: string, photo: TeamPhoto): void {
  const paths = teamPhotoPaths(teamId, photo.owner, photo.id);
  const b64 = photo.thumbUri?.slice('data:image/jpeg;base64,'.length);
  if (paths === null || !b64) return;
  const key = `${teamId}/${photo.owner}/${photo.id}`;
  if (queued.has(key)) return;
  queued.add(key);
  if (teamPhotoFileExists(paths.sprite)) {
    useSprites.getState().mark(key);
    return;
  }
  queue = queue.then(async () => {
    try {
      writeTeamPhotoFile(paths.thumb, b64);
      const out = await photoResizer.resize(teamPhotoUri(paths.thumb));
      writeTeamPhotoFile(paths.sprite, out.sprite.base64);
      useSprites.getState().mark(key);
    } catch {
      queued.delete(key); // try again on a later render
    }
  });
}

export function TeamTrailPhotos({
  drawnTrackIds,
  minZoom,
  deferPress,
}: {
  /** Trails the map draws itself, with their photos (mine). */
  drawnTrackIds: readonly string[];
  /** The main map's photo setting (null = photos off). */
  minZoom: number | null;
  deferPress: (run: () => void) => void;
}) {
  const { installedAt, show } = useExtensionPrefs('team');
  const teamId = useTeamStore((s) => s.activeId);
  const me = useTeamStore((s) => s.view?.me ?? null);
  const photos = useTeamStore((s) => s.photos);
  const ready = useSprites((s) => s.ready);

  const wanted = useMemo(() => {
    const drawn = new Set(drawnTrackIds);
    return photos
      .filter((p) => p.thumbUri !== null && !(p.owner === me && drawn.has(p.trackId)))
      .slice(-MAX_TEAM_PHOTOS);
  }, [photos, drawnTrackIds, me]);

  const on = installedAt !== 0 && show && minZoom !== null && teamId !== null;
  useEffect(() => {
    if (!on || teamId === null) return;
    for (const p of wanted) ensureSprite(teamId, p);
  }, [on, teamId, wanted]);

  const trackPhotos = useMemo(() => {
    if (teamId === null) return [];
    const out: TrackPhoto[] = [];
    for (const p of wanted) {
      const paths = teamPhotoPaths(teamId, p.owner, p.id);
      if (paths === null || !ready[`${teamId}/${p.owner}/${p.id}`]) continue;
      const photo: TrackPhoto = {
        id: p.id,
        trackId: p.trackId,
        distanceM: 0,
        lngLat: [p.lng, p.lat],
        placement: 'gps',
        file: paths.thumb,
        thumb: paths.thumb,
        sprite: paths.sprite,
        width: p.width,
        height: p.height,
        bytes: 0,
        createdAt: p.takenAt ?? 0,
        updatedAt: p.takenAt ?? 0,
      };
      if (p.takenAt !== null) photo.takenAt = p.takenAt;
      out.push(photo);
    }
    return out;
  }, [wanted, ready, teamId]);

  if (!on || trackPhotos.length === 0 || me === null) return null;
  return (
    <TrailPhotoLayers
      id="team-photos"
      photos={trackPhotos}
      minZoom={minZoom}
      deferPress={deferPress}
      onPhotoPress={(ids) => {
        const p = wanted.find((x) => x.id === ids[0]);
        if (p)
          usePhotoCard
            .getState()
            .show({ kind: 'team', owner: p.owner, trackId: p.trackId, photoId: p.id });
      }}
    />
  );
}
