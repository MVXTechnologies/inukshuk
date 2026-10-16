import { forAll, int, pick } from '../team/testing/prop';
import {
  choosePath,
  DEFAULT_PATH_POLICY,
  isUsable,
  PATH_KINDS,
  PATH_RANK,
  type PathKind,
  type PathPolicy,
  type PathStatus,
  type PeerPaths,
} from './path';

const P = DEFAULT_PATH_POLICY;
const T = 1_000_000;
const ready = (since: number, lastHeard = T): PathStatus => ({ state: 'ready', since, lastHeard });

describe('choosePath (design §2.5)', () => {
  it('prefers nearby, then direct, then relay when choosing a first primary', () => {
    const d = choosePath(
      { paths: { relay: ready(T), direct: ready(T), nearby: ready(T) }, signalling: true },
      P,
      T,
    );
    expect(d).toMatchObject({ primary: 'nearby', reason: 'first', dial: [], iceRestart: false });
    // Only nearby survives as a secondary; the others close.
    expect(d.close.sort()).toEqual(['direct', 'relay']);
  });

  it('is unreachable with nothing up and no room', () => {
    expect(choosePath({ paths: {}, signalling: false }, P, T)).toEqual({
      primary: undefined,
      close: [],
      dial: [],
      iceRestart: false,
      reason: 'unreachable',
    });
  });

  it('keeps nearby connected as a secondary', () => {
    const d = choosePath(
      {
        paths: { nearby: ready(T - 1000), direct: ready(T - 60_000) },
        primary: 'direct',
        signalling: true,
      },
      P,
      T,
    );
    // Nearby has been ready only 1 s: no upgrade yet, and it is not closed.
    expect(d.primary).toBe('direct');
    expect(d.reason).toBe('keep');
    expect(d.close).toEqual([]);
  });

  it('upgrades only after the better path has been ready for the hysteresis window', () => {
    const peer = (since: number): PeerPaths => ({
      paths: { direct: ready(since), relay: ready(T - 600_000) },
      primary: 'relay',
      signalling: true,
      lastDirectTryAt: T - 1000,
    });
    expect(choosePath(peer(T - P.hysteresisMs + 1), P, T)).toMatchObject({
      primary: 'relay',
      reason: 'keep',
      close: [],
    });
    expect(choosePath(peer(T - P.hysteresisMs), P, T)).toMatchObject({
      primary: 'direct',
      reason: 'upgrade',
      close: ['relay'],
    });
  });

  it('fails over at once after two missed keepalives', () => {
    const lastHeard = T - P.keepaliveMs * P.missesToFail;
    const d = choosePath(
      {
        paths: { nearby: ready(T - 600_000, lastHeard), relay: ready(T - 5000) },
        primary: 'nearby',
        signalling: true,
      },
      P,
      T,
    );
    expect(d).toMatchObject({ primary: 'relay', reason: 'failover' });
    // One missed keepalive is not enough.
    const d1 = choosePath(
      {
        paths: { nearby: ready(T - 600_000, lastHeard + 1), relay: ready(T - 5000) },
        primary: 'nearby',
        signalling: true,
      },
      P,
      T,
    );
    expect(d1.primary).toBe('nearby');
  });

  it('tries direct first, then relay after the direct timeout', () => {
    const none: PeerPaths = { paths: {}, signalling: true };
    expect(choosePath(none, P, T).dial).toEqual(['direct']);
    const trying: PeerPaths = {
      paths: { direct: { state: 'connecting', since: T, lastHeard: T } },
      signalling: true,
      directAttemptAt: T,
      lastDirectTryAt: T,
    };
    expect(choosePath(trying, P, T + P.directTimeoutMs - 1).dial).toEqual([]);
    expect(choosePath(trying, P, T + P.directTimeoutMs).dial).toEqual(['relay']);
    // Relay already connecting: nothing more to dial.
    const both: PeerPaths = {
      ...trying,
      paths: { ...trying.paths, relay: { state: 'connecting', since: T, lastHeard: T } },
    };
    expect(choosePath(both, P, T + P.directTimeoutMs).dial).toEqual([]);
  });

  it('dials relay straight away when direct failed recently', () => {
    const peer: PeerPaths = {
      paths: { direct: { state: 'failed', since: T - 1000, lastHeard: T - 9000 } },
      signalling: true,
      lastDirectTryAt: T - 9000,
    };
    const d = choosePath(peer, P, T);
    expect(d.dial).toEqual(['relay']);
    expect(d.close).toEqual(['direct']);
    // Long ago: direct again.
    expect(choosePath({ ...peer, lastDirectTryAt: T - P.directRetryMs }, P, T).dial).toEqual([
      'direct',
    ]);
  });

  it('retries direct with an ICE restart every 5 min while relayed', () => {
    const relayed: PeerPaths = {
      paths: { relay: ready(T - 600_000) },
      primary: 'relay',
      signalling: true,
      lastDirectTryAt: T - P.directRetryMs + 1,
    };
    expect(choosePath(relayed, P, T).iceRestart).toBe(false);
    expect(choosePath({ ...relayed, lastDirectTryAt: T - P.directRetryMs }, P, T).iceRestart).toBe(
      true,
    );
    expect(choosePath({ ...relayed, lastDirectTryAt: undefined }, P, T).iceRestart).toBe(true);
    // Not while an attempt runs.
    expect(
      choosePath({ ...relayed, lastDirectTryAt: undefined, directAttemptAt: T }, P, T).iceRestart,
    ).toBe(false);
  });

  it('does not dial the internet while nearby is the primary', () => {
    const d = choosePath({ paths: { nearby: ready(T - 1000) }, signalling: true }, P, T);
    expect(d.primary).toBe('nearby');
    expect(d.dial).toEqual([]);
  });

  describe('"Always use the relay"', () => {
    const forced: PathPolicy = { ...P, alwaysRelay: true };

    it('never uses, keeps or dials direct, and never ICE-restarts', () => {
      const d = choosePath(
        { paths: { direct: ready(T - 600_000), relay: ready(T - 600_000) }, signalling: true },
        forced,
        T,
      );
      expect(d.primary).toBe('relay');
      expect(d.close).toEqual(['direct']);
      expect(d.iceRestart).toBe(false);
      expect(choosePath({ paths: {}, signalling: true }, forced, T).dial).toEqual(['relay']);
      expect(isUsable('direct', ready(T), forced, T)).toBe(false);
    });

    it('still prefers nearby (a LAN peer already sees the private address)', () => {
      const d = choosePath(
        { paths: { nearby: ready(T - 1000), relay: ready(T - 1000) }, signalling: true },
        forced,
        T,
      );
      expect(d.primary).toBe('nearby');
    });

    it('waits while a relay connects', () => {
      const d = choosePath(
        { paths: { relay: { state: 'connecting', since: T, lastHeard: T } }, signalling: true },
        forced,
        T,
      );
      expect(d.dial).toEqual([]);
    });
  });

  describe('properties', () => {
    const genStatus = (rnd: () => number): PathStatus | undefined => {
      const r = rnd();
      if (r < 0.25) return undefined;
      const state = pick(rnd, ['connecting', 'ready', 'ready', 'failed'] as const);
      return { state, since: T - int(rnd, 0, 120_000), lastHeard: T - int(rnd, 0, 60_000) };
    };
    const genPeer = (rnd: () => number): PeerPaths => {
      const paths: Partial<Record<PathKind, PathStatus>> = {};
      for (const k of PATH_KINDS) {
        const s = genStatus(rnd);
        if (s !== undefined) paths[k] = s;
      }
      const primaries = [undefined, ...PATH_KINDS] as const;
      return {
        paths,
        primary: pick(rnd, primaries),
        signalling: rnd() < 0.7,
        directAttemptAt: rnd() < 0.3 ? T - int(rnd, 0, 20_000) : undefined,
        lastDirectTryAt: rnd() < 0.5 ? T - int(rnd, 0, 600_000) : undefined,
      };
    };

    it('the primary is always usable, and never closed', () => {
      forAll(
        2705,
        2000,
        (rnd) => ({ peer: genPeer(rnd), forced: rnd() < 0.3 }),
        ({ peer, forced }) => {
          const policy = { ...P, alwaysRelay: forced };
          const d = choosePath(peer, policy, T);
          if (d.primary !== undefined) {
            expect(isUsable(d.primary, peer.paths[d.primary], policy, T)).toBe(true);
            expect(d.close).not.toContain(d.primary);
          }
          expect(d.close).not.toContain('nearby');
          expect(d.dial.length).toBeLessThanOrEqual(1);
          if (forced) {
            expect(d.dial).not.toContain('direct');
            expect(d.primary).not.toBe('direct');
            expect(d.iceRestart).toBe(false);
          }
          // Deterministic.
          expect(choosePath(peer, policy, T)).toEqual(d);
        },
      );
    });

    it('monotonic: a usable primary is never left for a worse path', () => {
      forAll(2706, 2000, genPeer, (peer) => {
        const d = choosePath(peer, P, T);
        const cur = peer.primary;
        if (cur !== undefined && isUsable(cur, peer.paths[cur], P, T)) {
          expect(d.primary).toBeDefined();
          expect(PATH_RANK[d.primary!]).toBeLessThanOrEqual(PATH_RANK[cur]);
        }
        // Whenever something is usable, a primary is chosen.
        const any = PATH_KINDS.some((k) => isUsable(k, peer.paths[k], P, T));
        expect(d.primary !== undefined).toBe(any);
      });
    });
  });
});
