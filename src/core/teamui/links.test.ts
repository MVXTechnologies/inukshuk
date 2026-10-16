import { LINK_LABEL, linkReason, memberLinks, type LinkInputs } from './links';
import { teamBarSummary, type BarMember } from './teamBar';

const base: LinkInputs = {
  members: ['julie', 'alex', 'noe', 'lea', 'sam'],
  links: [
    { member: 'julie', path: 'direct' },
    { member: 'alex', path: 'relay' },
    { member: 'noe', path: 'nearby' },
    { member: 'noe', path: 'direct' },
  ],
  paths: [
    { member: 'noe', primary: 'nearby', signalling: true, connecting: false },
    { member: 'sam', primary: undefined, signalling: true, connecting: true },
  ],
  internetOn: true,
  rtcCapable: new Set(['julie', 'alex', 'noe', 'sam']),
};

describe('memberLinks', () => {
  it('names the path that carries each teammate, nearby first', () => {
    const l = memberLinks(base);
    expect(Object.fromEntries(l)).toEqual({
      julie: 'direct',
      alex: 'relay',
      noe: 'nearby',
      lea: 'old',
      sam: 'connecting',
    });
  });

  it('the primary wins when it is open', () => {
    const l = memberLinks({
      ...base,
      paths: [{ member: 'noe', primary: 'direct', signalling: true, connecting: false }],
    });
    expect(l.get('noe')).toBe('direct');
  });

  it('with the internet off nobody is "connecting" or "needs update": just out of reach', () => {
    const l = memberLinks({ ...base, internetOn: false, links: [] });
    expect([...l.values()]).toEqual(['out', 'out', 'out', 'out', 'out']);
  });

  it('labels and reasons', () => {
    expect(LINK_LABEL.relay).toBe('Relayed');
    const o = { alwaysRelay: false, lastSeenAt: null, now: 0 };
    expect(linkReason('relay', o)).toBe('No direct path between your networks');
    expect(linkReason('relay', { ...o, alwaysRelay: true })).toBe(
      'Through the relay, as you chose',
    );
    expect(linkReason('out', o)).toBe('Not seen yet');
    expect(linkReason('out', { ...o, lastSeenAt: 0, now: 34 * 60_000 })).toBe(
      'Last seen 34 min ago',
    );
  });
});

describe('the pill with the internet (G7)', () => {
  const m = (id: string, isMe = false): BarMember => ({
    id,
    name: id,
    initials: id.slice(0, 2),
    color: '#000',
    isMe,
    active: true,
    lastSeenAt: null,
  });
  const inputs = {
    name: 'Crew',
    members: [m('me', true), m('julie'), m('noe')],
    positions: [],
    meshRunning: true,
    now: 0,
  };

  it('cloud when this phone is in its team’s room', () => {
    const s = teamBarSummary({ ...inputs, connected: new Set(['julie']), internet: 'up' });
    expect(s.sync).toBe('net');
    expect(s.status).toBe('2/3 online');
    expect(s.a11y).toContain('syncing over the internet');
  });

  it('amber when the internet is lost but a nearby phone syncs; offline when none', () => {
    expect(teamBarSummary({ ...inputs, connected: new Set(['noe']), internet: 'down' }).sync).toBe(
      'noNet',
    );
    expect(
      teamBarSummary({ ...inputs, connected: new Set(), internet: 'down', meshRunning: false })
        .sync,
    ).toBe('off');
  });

  it('a team with the internet off reads as in 2.6', () => {
    expect(teamBarSummary({ ...inputs, connected: new Set(['noe']) }).sync).toBe('lan');
  });
});
