import type { MeshNetworkInfo } from '@core/mesh/hotspot';

/**
 * The team mesh transport contract (#589): what the sync layer sees of the
 * LAN / hotspot network. It moves opaque, already-sealed frames between
 * peers; identity, crypto and sync live in `src/core/team` (`SyncSession`).
 *
 * Two implementations: the native module (`meshNative.ts`,
 * modules/inukshuk-mesh) and an in-memory loopback for dev and E2E builds
 * (`loopbackMesh.ts`). Design: docs/design/team-mesh.md.
 *
 * A peer id names ONE connection: a reconnect is a new peer id (and a new
 * sync session) under the same dial id.
 */

/** Optional overrides; the native side clamps every value into a safe range. */
export interface MeshConfigInput {
  preferredPort?: number;
  maxFrameBytes?: number;
  maxPeers?: number;
  maxInboundPerIp?: number;
  maxPendingInbound?: number;
  acceptsPerMinutePerIp?: number;
  bytesPerSec?: number;
  framesPerSec?: number;
  maxQueuedBytes?: number;
  maxInboxBytesPerPeer?: number;
  maxInboxBytes?: number;
  idleTimeoutMs?: number;
  keepaliveMs?: number;
  handshakeTimeoutMs?: number;
  connectTimeoutMs?: number;
  defaultBanMs?: number;
}

export type MeshDirection = 'in' | 'out';

export interface MeshPeer {
  peerId: string;
  /** The dial that produced this connection (outbound only). */
  dialId: string | null;
  host: string;
  port: number;
  direction: MeshDirection;
}

export interface MeshService {
  serviceId: string;
  tag: string;
  /** Android resolves before reporting; iOS resolves only on connect (null). */
  host: string | null;
  port: number | null;
}

export type MeshDisconnectReason =
  | 'local'
  | 'remote-closed'
  | 'io-error'
  | 'idle'
  | 'handshake-timeout'
  | 'connect-failed'
  | 'connect-timeout'
  | 'bad-magic'
  | 'incompatible'
  | 'oversize'
  | 'banned'
  | 'limit'
  | 'stopped';

export interface MeshPeerStats {
  peerId: string;
  dialId: string | null;
  host: string;
  port: number;
  direction: MeshDirection;
  established: boolean;
  queuedBytes: number;
  inboxBytes: number;
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
  keepalivesIn: number;
  throttled: boolean;
}

export interface MeshStats {
  running: boolean;
  listening?: boolean;
  port?: number | null;
  peers: MeshPeerStats[];
  inboxBytes?: number;
  inboxFrames?: number;
  activeBans?: number;
  rejectedConnections?: number;
  violations?: number;
}

export type LocalNetworkState = 'unknown' | 'granted' | 'denied';

export interface MeshState {
  running: boolean;
  port: number | null;
  advertising: boolean;
  browsing: boolean;
  /** iOS Local Network privacy; always 'granted' on Android. */
  localNetwork: LocalNetworkState;
}

export type MeshEvent =
  | { type: 'peer-found'; service: MeshService }
  | { type: 'peer-lost'; serviceId: string }
  | { type: 'connected'; peer: MeshPeer }
  | {
      type: 'disconnected';
      /** null when a dial failed before any connection was announced. */
      peerId: string | null;
      dialId: string | null;
      reason: MeshDisconnectReason | string;
      /** Set when the dial will retry after this many ms. */
      retryInMs: number | null;
    }
  | { type: 'frame'; peerId: string; data: Uint8Array }
  | { type: 'writable'; peerId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'state'; state: MeshState }
  | { type: 'stats'; stats: MeshStats };

export type SendResult =
  | { ok: true; queuedBytes: number }
  /** Not queued. 'backpressure': wait for a 'writable' event for this peer. */
  | { ok: false; reason: 'backpressure' | 'no-peer' | 'too-large' };

export interface MeshTransport {
  readonly kind: 'native' | 'loopback';
  start(config?: MeshConfigInput): Promise<{ port: number }>;
  stop(): Promise<void>;
  /** Advertise `_inukshuk-team._tcp` with this discovery tag (`@core/mesh/tag`). */
  startAdvertising(tag: string): Promise<void>;
  stopAdvertising(): void;
  /** Browse for teammates; `tag` filters (null reports every Inukshuk team). */
  startBrowsing(tag: string | null): Promise<void>;
  stopBrowsing(): void;
  /** Dial host:port (manual or invite join). Returns the dial id. */
  connect(host: string, port: number, opts?: { reconnect?: boolean }): string;
  /** Dial a discovered service. Returns the dial id. */
  connectService(serviceId: string, opts?: { reconnect?: boolean }): string;
  /** Close a peer (peer id) or cancel a dial and its retries (dial id). */
  disconnect(id: string): void;
  send(peerId: string, frame: Uint8Array): SendResult;
  /** Close the peer and refuse its address for this long (capped at 24 h). */
  ban(peerId: string, durationMs: number): void;
  stats(): MeshStats;
  state(): MeshState;
  networkInfo(): MeshNetworkInfo;
  subscribe(listener: (event: MeshEvent) => void): () => void;
}

/** Thrown for mesh failures other than the expected send outcomes. */
export class MeshTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MeshTransportError';
  }
}

/** A tiny listener set shared by both implementations. */
export class MeshListeners {
  private readonly set = new Set<(event: MeshEvent) => void>();

  add(listener: (event: MeshEvent) => void): () => void {
    this.set.add(listener);
    return () => this.set.delete(listener);
  }

  emit(event: MeshEvent): void {
    for (const l of [...this.set]) {
      try {
        l(event);
      } catch {
        // One failing listener must not starve the others of frames.
      }
    }
  }

  get size(): number {
    return this.set.size;
  }
}
