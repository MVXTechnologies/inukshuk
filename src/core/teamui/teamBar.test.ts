import { IMPERIAL, METRIC, NAUTICAL } from '@core/format';

import { distanceText, memberAgeMs, panelMembers, teamBarSummary, type BarMember } from './teamBar';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HERE = { latitude: 46.8, longitude: -71.2 };

const m = (id: string, name: string, over: Partial<BarMember> = {}): BarMember => ({
  id,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  color: '#123456',
  isMe: false,
  active: true,
  lastSeenAt: null,
  ...over,
});

/** Chic-Chocs crew: me, Julie (live), Alex (1 min), Noé (live), Sam (8 min), Léa (34 min). */
function crew() {
  const members = [
    m('me', 'Marc', { isMe: true }),
    m('julie', 'Julie Tremblay'),
    m('alex', 'Alex Lavoie'),
    m('noe', 'Noé Gagnon'),
    m('sam', 'Sam Bouchard', { lastSeenAt: NOW - 8 * MIN }),
    m('lea', 'Léa Pelletier'),
    m('gone', 'Old Member', { active: false }),
  ];
  const positions = [
    { id: 'julie', lat: 46.8026, lon: -71.1977, ageMs: 0 },
    { id: 'alex', lat: 46.811, lon: -71.2, ageMs: MIN },
    { id: 'noe', lat: 46.796, lon: -71.205, ageMs: 10_000 },
    { id: 'lea', lat: 46.757, lon: -71.2, ageMs: 34 * MIN },
  ];
  return { members, positions };
}

describe('teamBarSummary', () => {
  it('the three freshest faces, "4/6 online", syncing nearby', () => {
    const { members, positions } = crew();
    const s = teamBarSummary({
      name: 'Chic-Chocs crew',
      members,
      positions,
      connected: new Set(['julie']),
      meshRunning: true,
      now: NOW,
    });
    expect(s.faces.map((f) => f.id)).toEqual(['julie', 'noe', 'alex']);
    expect(s.faces.every((f) => f.band === 'fresh')).toBe(true);
    expect(s).toMatchObject({
      total: 6,
      online: 4,
      solo: false,
      sync: 'lan',
      status: '4/6 online',
    });
    expect(s.a11y).toBe('Chic-Chocs crew: 4 of 6 online, syncing nearby. Opens the team panel');
  });

  it('a teammate connected now counts as online without a position', () => {
    const { members } = crew();
    const s = teamBarSummary({
      name: 'T',
      members,
      positions: [],
      connected: new Set(['sam']),
      meshRunning: true,
      now: NOW,
    });
    expect(s.online).toBe(2);
    expect(s.faces[0]).toMatchObject({ id: 'sam', band: 'fresh' });
    // Never heard of: hollow (lost), after the others.
    expect(s.faces[1]?.band).toBe('lost');
  });

  it('solo: "Only you"; looking when the mesh runs with nobody in reach', () => {
    const s = teamBarSummary({
      name: 'Week-end Charlevoix',
      members: [m('me', 'Marc', { isMe: true })],
      positions: [],
      connected: new Set(),
      meshRunning: true,
      now: NOW,
    });
    expect(s).toMatchObject({ solo: true, total: 1, online: 1, sync: 'look', status: 'Only you' });
    expect(s.faces).toEqual([]);
    expect(s.a11y).toContain('only you, looking for teammates');
  });

  it('disconnected: "Offline · N min" since the last word from anyone', () => {
    const { members, positions } = crew();
    const s = teamBarSummary({
      name: 'T',
      members,
      positions: positions.map((p) => ({ ...p, ageMs: p.ageMs + 12 * MIN })),
      connected: new Set(),
      meshRunning: false,
      now: NOW,
    });
    expect(s).toMatchObject({ sync: 'off', offlineMin: 8, status: 'Offline · 8 min' });
    const never = teamBarSummary({
      name: 'T',
      members: [m('me', 'Marc', { isMe: true }), m('x', 'X')],
      positions: [],
      connected: new Set(),
      meshRunning: false,
      now: NOW,
    });
    expect(never.status).toBe('Offline');
  });

  it('memberAgeMs: the newest of position, contact and session', () => {
    expect(memberAgeMs({ id: 'a', lastSeenAt: null }, undefined, new Set(), NOW)).toBeNull();
    expect(
      memberAgeMs({ id: 'a', lastSeenAt: NOW - 3 * MIN }, { ageMs: 9 * MIN }, new Set(), NOW),
    ).toBe(3 * MIN);
    expect(memberAgeMs({ id: 'a', lastSeenAt: NOW + 5 }, undefined, new Set(), NOW)).toBe(0);
    expect(memberAgeMs({ id: 'a', lastSeenAt: null }, { ageMs: 9 }, new Set(['a']), NOW)).toBe(0);
  });
});

describe('panelMembers', () => {
  it('live first and nearest first, then stale, lost and never seen; never me or the inactive', () => {
    const { members, positions } = crew();
    const rows = panelMembers(members, positions, new Set(), HERE, NOW);
    expect(rows.map((r) => r.id)).toEqual(['julie', 'noe', 'alex', 'sam', 'lea']);
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get('julie')).toMatchObject({ line: 'Live', compass: 'NE', lastPosition: false });
    expect(by.get('alex')?.line).toBe('Live · 1 min ago');
    expect(by.get('sam')).toMatchObject({
      line: 'Last seen 8 min ago',
      band: 'stale',
      distanceM: null,
    });
    expect(by.get('lea')).toMatchObject({
      line: 'Lost · 34 min',
      band: 'lost',
      lastPosition: true,
    });
    expect(distanceText(by.get('julie')!.distanceM!, METRIC)).toBe('338 m');
  });

  it('without my position: no distance, fresh ones by age', () => {
    const { members, positions } = crew();
    const rows = panelMembers([...members, m('new', 'Zoé New')], positions, new Set(), null, NOW);
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(['julie', 'noe', 'alex']);
    expect(rows.every((r) => r.distanceM === null)).toBe(true);
    expect(rows[rows.length - 1]).toMatchObject({ id: 'new', line: 'Not seen yet' });
  });

  it('distanceText', () => {
    expect(distanceText(640.4, METRIC)).toBe('640 m');
    expect(distanceText(1234, METRIC)).toBe('1.2 km');
    expect(distanceText(12_345, METRIC)).toBe('12 km');
    // In the user's units (#702).
    expect(distanceText(200, IMPERIAL)).toBe('656 ft');
    expect(distanceText(1234, IMPERIAL)).toBe('0.8 mi');
    expect(distanceText(12_345, NAUTICAL)).toBe('6.7 NM');
    expect(distanceText(120, NAUTICAL)).toBe('120 m');
  });
});
