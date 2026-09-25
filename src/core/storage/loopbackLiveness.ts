/**
 * When the in-app loopback server must be proven alive, and what to do when
 * it is not (iOS resume: #381, #385 and the "Load failed" cluster).
 *
 * iOS reclaims a suspended app's listening sockets (Apple TN2277, "Networking
 * and Multitasking"). lighttpd does not notice: `accept()` errors are logged
 * and its event loop carries on (lighttpd1.4 `network.c`), so the native
 * thread never exits, `@dr.pogodin/react-native-static-server` never emits
 * CRASHED, and its `state` stays ACTIVE while every connection to the port is
 * refused. The library's own state is therefore no evidence of liveness; only
 * a connection is. This module decides when to make one (a probe), and what
 * a failed probe leads to — pure, so the policy is a tested table and not a
 * set of timers scattered through a component.
 *
 * The effects (the probe, the restart, reloading the rasterizer page) live in
 * `@data/localServer` and `PdfRasterizer`.
 */

/** A probe that has not connected within this is a dead server. */
export const PROBE_TIMEOUT_MS = 1_500;
/** Served work after this long without proof of life is preceded by a probe. */
export const REVERIFY_AFTER_MS = 60_000;
/** Restarts allowed inside {@link RESTART_WINDOW_MS} before giving up on the server. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;

export interface LoopbackHealth {
  /** Last proof the server accepts connections; `null` when it is suspect. */
  readonly verifiedAt: number | null;
  /** When the app went to the background; `null` while it is in front. */
  readonly backgroundedAt: number | null;
  /** When recent restarts happened, oldest first. */
  readonly restarts: readonly number[];
}

export type LoopbackSignal =
  /** The app left the foreground. */
  | { kind: 'background' }
  /** The app is in front again (after a background, the listener is suspect). */
  | { kind: 'foreground' }
  /** A probe connected, or a served render completed. */
  | { kind: 'reachable' }
  /** A probe failed, or a served request failed at the connection level. */
  | { kind: 'unreachable' }
  /** A fresh server was started (and is, as of now, reachable). */
  | { kind: 'restarted' };

/** Health of a server that has just started. */
export function startedHealth(now: number): LoopbackHealth {
  return { verifiedAt: now, backgroundedAt: null, restarts: [] };
}

export function applyLoopbackSignal(
  health: LoopbackHealth,
  signal: LoopbackSignal,
  now: number,
): LoopbackHealth {
  switch (signal.kind) {
    case 'background':
      return { ...health, backgroundedAt: health.backgroundedAt ?? now };
    case 'foreground':
      return health.backgroundedAt === null
        ? health
        : { ...health, backgroundedAt: null, verifiedAt: null };
    case 'reachable':
      return { ...health, verifiedAt: now };
    case 'unreachable':
      return { ...health, verifiedAt: null };
    case 'restarted':
      return { ...health, verifiedAt: now, restarts: [...recentRestarts(health, now), now] };
  }
}

/** Must the server be probed before served work is dispatched at `now`? */
export function needsProbe(health: LoopbackHealth, now: number): boolean {
  return health.verifiedAt === null || now - health.verifiedAt >= REVERIFY_AFTER_MS;
}

/**
 * After a failed probe: restart, unless the restart budget for the window is
 * spent — then give up on the server (the rasterizer drops to inline mode),
 * rather than restart-loop a server the OS keeps killing.
 */
export function recoveryAfterFailedProbe(
  health: LoopbackHealth,
  now: number,
): 'restart' | 'give-up' {
  return recentRestarts(health, now).length < MAX_RESTARTS ? 'restart' : 'give-up';
}

function recentRestarts(health: LoopbackHealth, now: number): number[] {
  return health.restarts.filter((at) => now - at < RESTART_WINDOW_MS);
}

/**
 * True for a served render that failed at the transport level: the page's
 * fetch trace (#331) counts at least one failed request. pdf.js reports a
 * wrong HTTP status as its own error, without a failed fetch, so what is
 * left is a refused or dropped connection — a property of the server, never
 * of the PDF page.
 */
export function isServedTransportFailure(message: string): boolean {
  return /\[served fetch: \d+ requests, [1-9]\d* failed/.test(message);
}

/**
 * Move a served URL from a dead origin to its replacement. Anything not on
 * `from` (an inline request, another origin) is returned unchanged.
 */
export function rebaseServedUrl(url: string, from: string, to: string): string {
  const base = from.replace(/\/+$/, '');
  return url.startsWith(`${base}/`) ? `${to.replace(/\/+$/, '')}${url.slice(base.length)}` : url;
}
