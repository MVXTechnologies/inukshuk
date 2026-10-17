/**
 * Per-peer path policy (2.7.0 design §2.5, #705): which carrier instance to a
 * remote phone is the primary sync link, which others stay up, and what the
 * platform `PathManager` should try next. Pure: the manager feeds it the
 * observed state and the time, and carries out the decision.
 *
 * - **Preference** when several paths are up: `nearby > direct > relay`.
 *   Nearby costs no data and no relay quota and works offline.
 * - **Internet failover:** try `direct` for {@link PathPolicy.directTimeoutMs};
 *   then go `relay`. While relayed (and not forced), retry direct with an ICE
 *   restart every {@link PathPolicy.directRetryMs}.
 * - **"Always use the relay"** (per phone): `direct` is never used or dialled.
 * - **One primary per peer.** A secondary stays connected only when it is
 *   `nearby` (it costs nothing), or while it is a better path proving itself.
 * - **Failover** is immediate when the primary misses
 *   {@link PathPolicy.missesToFail} keepalives; **upgrades** wait until the
 *   better path has been ready for {@link PathPolicy.hysteresisMs} (no
 *   flapping). Switching is safe: sessions resync by version vector.
 */
export type PathKind = 'nearby' | 'direct' | 'relay';

export const PATH_KINDS: readonly PathKind[] = ['nearby', 'direct', 'relay'];

/** Lower is better. */
export const PATH_RANK: Readonly<Record<PathKind, number>> = { nearby: 0, direct: 1, relay: 2 };

export interface PathStatus {
  state: 'connecting' | 'ready' | 'failed';
  /** When it entered `state`. */
  since: number;
  /** Last frame (any, keepalives included) heard on it. */
  lastHeard: number;
}

export interface PeerPaths {
  readonly paths: Readonly<Partial<Record<PathKind, PathStatus>>>;
  /** The primary chosen by the previous decision. */
  readonly primary?: PathKind | undefined;
  /** Both phones are in the group's room (internet on): an internet path can be negotiated. */
  readonly signalling: boolean;
  /** When the current direct attempt (ICE) started, if one is running. */
  readonly directAttemptAt?: number | undefined;
  /** When direct was last tried (attempt or ICE restart). */
  readonly lastDirectTryAt?: number | undefined;
}

export interface PathPolicy {
  /** "Always use the relay": hide this phone's public IP from teammates. */
  alwaysRelay: boolean;
  keepaliveMs: number;
  missesToFail: number;
  hysteresisMs: number;
  directTimeoutMs: number;
  directRetryMs: number;
}

export const DEFAULT_PATH_POLICY: PathPolicy = {
  alwaysRelay: false,
  keepaliveMs: 15_000,
  missesToFail: 2,
  hysteresisMs: 10_000,
  directTimeoutMs: 8_000,
  directRetryMs: 5 * 60_000,
};

export interface PathDecision {
  /** The path sync runs on, or none. */
  primary: PathKind | undefined;
  /** Paths to close now. */
  close: PathKind[];
  /** Internet paths to start (at most one). */
  dial: ('direct' | 'relay')[];
  /** While relayed: try an ICE restart toward direct. */
  iceRestart: boolean;
  reason: 'keep' | 'failover' | 'upgrade' | 'first' | 'unreachable';
}

/** Whether a path is up and has been heard recently enough. */
export function isUsable(
  kind: PathKind,
  s: PathStatus | undefined,
  policy: PathPolicy,
  now: number,
): s is PathStatus {
  if (s === undefined || s.state !== 'ready') return false;
  if (kind === 'direct' && policy.alwaysRelay) return false;
  return now - s.lastHeard < policy.keepaliveMs * policy.missesToFail;
}

function best(kinds: readonly PathKind[]): PathKind | undefined {
  return [...kinds].sort((a, b) => PATH_RANK[a] - PATH_RANK[b])[0];
}

/** Total and deterministic: the same inputs always give the same decision. */
export function choosePath(peer: PeerPaths, policy: PathPolicy, now: number): PathDecision {
  const usable = PATH_KINDS.filter((k) => isUsable(k, peer.paths[k], policy, now));
  const current = peer.primary;
  let primary: PathKind | undefined;
  let reason: PathDecision['reason'];
  if (current !== undefined && usable.includes(current)) {
    // Upgrade only to a strictly better path that has proved itself for the hysteresis window.
    const better = usable.filter(
      (k) => PATH_RANK[k] < PATH_RANK[current] && now - peer.paths[k]!.since >= policy.hysteresisMs,
    );
    primary = best(better) ?? current;
    reason = primary === current ? 'keep' : 'upgrade';
  } else {
    primary = best(usable);
    reason = primary === undefined ? 'unreachable' : current === undefined ? 'first' : 'failover';
  }

  // Close what is neither primary, nor nearby, nor a better path still proving itself.
  const close: PathKind[] = [];
  for (const k of PATH_KINDS) {
    const s = peer.paths[k];
    if (s === undefined || k === primary || k === 'nearby') continue;
    if (k === 'direct' && policy.alwaysRelay) {
      close.push(k);
      continue;
    }
    if (s.state === 'failed') {
      close.push(k);
      continue;
    }
    const proving = primary !== undefined && PATH_RANK[k] < PATH_RANK[primary];
    if (!proving && s.state === 'ready' && primary !== undefined) close.push(k);
  }

  const dial: ('direct' | 'relay')[] = [];
  let iceRestart = false;
  const internetUp = usable.some((k) => k !== 'nearby');
  const nearbyPrimary = primary === 'nearby';
  if (peer.signalling && !internetUp && !nearbyPrimary) {
    const direct = peer.paths.direct;
    const relay = peer.paths.relay;
    const relayBusy = relay !== undefined && relay.state === 'connecting';
    if (policy.alwaysRelay) {
      if (!relayBusy) dial.push('relay');
    } else if (peer.directAttemptAt === undefined && direct?.state !== 'connecting') {
      const triedRecently =
        peer.lastDirectTryAt !== undefined && now - peer.lastDirectTryAt < policy.directRetryMs;
      if (!triedRecently) dial.push('direct');
      else if (!relayBusy) dial.push('relay');
    } else if (
      peer.directAttemptAt !== undefined &&
      now - peer.directAttemptAt >= policy.directTimeoutMs &&
      !relayBusy
    ) {
      dial.push('relay');
    }
  }
  if (
    primary === 'relay' &&
    !policy.alwaysRelay &&
    peer.directAttemptAt === undefined &&
    (peer.lastDirectTryAt === undefined || now - peer.lastDirectTryAt >= policy.directRetryMs)
  ) {
    iceRestart = true;
  }
  return { primary, close, dial, iceRestart, reason };
}
