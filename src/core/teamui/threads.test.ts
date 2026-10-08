import {
  addMember,
  device,
  exchange,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from '@core/team/testing/fixtures';

import { teamPhotos, trailThread } from './comments';
import { resolvedMessages, teamPins } from './pins';
import { teamShares, trackFields } from './shares';
import { teamThreads, threadsUnread } from './threads';

function world() {
  const w = newWorld();
  const d = device();
  addMember(w.root, d, 'member', T0 + 1);
  const other = joinReplica(w, d, w.root, T0 + 2);
  const owner = w.root;
  owner.write(T0 + MIN, 'e.set', {
    k: 'photo',
    id: 'ph1',
    f: { trackId: 'tr1', lngLat: [-71.2, 46.8], takenAt: T0, caption: 'Summit', tb: 'AAAA' },
  });
  owner.write(T0 + MIN, 'e.set', {
    k: 'photo',
    id: 'ph2',
    f: { trackId: 'tr1', lngLat: [-71.21, 46.81], takenAt: T0, tb: 'AAAA' },
  });
  owner.write(T0 + MIN, 'e.set', {
    k: 'track',
    id: 'tr1',
    f: trackFields({
      name: 'Mont Wright',
      points: [
        { latitude: 46.8, longitude: -71.2 },
        { latitude: 46.81, longitude: -71.21 },
      ],
      distanceM: 1500,
      ascentM: 120,
      startedAt: T0,
    })!,
  });
  exchange(owner, other, T0 + 2 * MIN);
  other.write(T0 + 3 * MIN, 'e.set', {
    k: 'comment',
    id: 'c1',
    f: { photoId: 'ph1', text: 'Wow' },
  });
  other.write(T0 + 4 * MIN, 'e.set', {
    k: 'comment',
    id: 'c2',
    f: { photoId: 'ph1', text: 'On repart à 14 h?' },
  });
  other.write(T0 + 5 * MIN, 'msg', { id: 't1', th: trailThread('tr1'), tx: 'Belle boucle' });
  owner.write(T0 + 6 * MIN, 'msg', {
    id: 'p1',
    th: `pin:${owner.id}:p1`,
    tx: 'Rockfall here',
    ll: [-70.92, 47.09],
  });
  exchange(owner, other, T0 + 8 * MIN);
  return { owner, other };
}

function rows(
  replica: ReturnType<typeof world>['owner'],
  seen: Record<string, number> = {},
  resolved?: Set<string>,
) {
  const data = replica.data(T0 + 9 * MIN);
  return teamThreads({
    data,
    me: replica.id,
    photos: teamPhotos(data),
    pins: teamPins(data),
    tracks: teamShares(data).tracks,
    resolved: resolved ?? resolvedMessages(data),
    seenAt: (k) => seen[k] ?? 0,
  });
}

describe('team chat sub-threads', () => {
  it('lists photo, pin and trail threads with their last message, newest first', () => {
    const { owner } = world();
    const r = rows(owner);
    expect(r.map((x) => [x.key, x.title, x.count, x.last.text])).toEqual([
      [`pin:${owner.id}:p1`, 'Rockfall here', 1, 'Rockfall here'],
      ['trail:tr1', 'Mont Wright', 1, 'Belle boucle'],
      ['photo:ph1', 'Summit', 2, 'On repart à 14 h?'],
    ]);
    // A photo without comments is no thread yet.
    expect(r.some((x) => x.key === 'photo:ph2')).toBe(false);
    expect(r[2]!.target).toEqual({
      kind: 'photo',
      owner: owner.id,
      trackId: 'tr1',
      photoId: 'ph1',
      at: [-71.2, 46.8],
    });
    expect(r[2]!.thumbUri).toBe('data:image/jpeg;base64,AAAA');
  });

  it('counts unread messages since I last looked, never my own', () => {
    const { owner } = world();
    const r = rows(owner, { 'photo:ph1': T0 + 3 * MIN });
    const byKey = new Map(r.map((x) => [x.key, x]));
    expect(byKey.get('photo:ph1')!.unread).toBe(1); // c2 only
    expect(byKey.get('trail:tr1')!.unread).toBe(1);
    expect(byKey.get(`pin:${owner.id}:p1`)!.unread).toBe(0); // mine
    expect(threadsUnread(r)).toBe(2);
  });

  it('sinks resolved pins below the open threads, and out of the unread count', () => {
    const { other, owner } = world();
    const r = rows(other, {}, new Set([`${owner.id}:p1`]));
    expect(r.at(-1)!.key).toBe(`pin:${owner.id}:p1`);
    expect(r.at(-1)!.resolved).toBe(true);
    expect(r.at(-1)!.unread).toBe(1);
    // The rest are mine; the resolved pin's message no longer counts.
    expect(threadsUnread(r)).toBe(0);
  });
});
