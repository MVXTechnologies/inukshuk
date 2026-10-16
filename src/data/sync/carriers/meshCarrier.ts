import type { Carrier, CarrierConn, CarrierEvent, SendResult } from '@core/group/link';
import type { Lane } from '@core/group/lanes';

import type { MeshEvent, MeshPeer, MeshTransport } from '@data/team/meshTransport';

/**
 * The LAN / hotspot mesh as a link-layer {@link Carrier} (2.7.0 design §2.2,
 * #705): `MeshTransport` (native module or loopback hub) unchanged underneath.
 *
 * - one mesh connection (`MeshPeer.peerId`) is one {@link CarrierConn}; a
 *   reconnect is a new connection, as on the transport;
 * - `send` maps the transport's outcomes: `backpressure` means the frame was
 *   NOT queued (the caller keeps it and waits for `writable`), `no-peer` and
 *   `too-large` mean the connection is unusable (`closed`; an oversize frame
 *   also hangs up, as the 2.6 session host did);
 * - `ban` is the transport's IP ban: on the LAN the address is the peer;
 * - a dial that failed before any connection (`disconnected` with no peer)
 *   is the discovery layer's business (`MeshLink`), not a carrier event.
 *
 * The mesh moves opaque frames and has no lanes: `lane` is accepted for the
 * interface and ignored. Discovery, advertising and dialling stay in
 * `MeshLink`, which shares the same transport.
 */

/** The mesh frame cap (native `MeshConfig.maxFrameBytes`, loopback default). */
export const MESH_MAX_FRAME_BYTES = 512 * 1024;

/** A mesh connection: the carrier's view plus the transport's peer record. */
export interface MeshConn extends CarrierConn {
  readonly peer: MeshPeer;
  /** Always there on the LAN: the address is the peer. */
  ban(ms: number): void;
}

export class MeshCarrier implements Carrier {
  readonly kind = 'mesh' as const;
  private readonly conns = new Map<string, MeshConn>();

  constructor(
    private readonly transport: MeshTransport,
    private readonly maxFrameBytes = MESH_MAX_FRAME_BYTES,
  ) {}

  /** The live connection with this id (a `MeshPeer.peerId`). */
  conn(connId: string): MeshConn | undefined {
    return this.conns.get(connId);
  }

  /**
   * Carrier events for one listener, translated from the transport's. Each
   * subscription sees only connections made while it listens.
   */
  subscribe(listener: (e: CarrierEvent) => void): () => void {
    const mine = new Set<string>();
    const off = this.transport.subscribe((e) => {
      const out = this.translate(e, mine);
      if (out !== undefined) listener(out);
    });
    return () => {
      off();
      for (const id of mine) this.conns.delete(id);
      mine.clear();
    };
  }

  private translate(e: MeshEvent, mine: Set<string>): CarrierEvent | undefined {
    switch (e.type) {
      case 'connected': {
        const conn = this.wrap(e.peer);
        this.conns.set(conn.connId, conn);
        mine.add(conn.connId);
        return { type: 'conn', conn, direction: e.peer.direction };
      }
      case 'frame':
        return mine.has(e.peerId) ? { type: 'frame', connId: e.peerId, data: e.data } : undefined;
      case 'writable':
        return mine.has(e.peerId) ? { type: 'writable', connId: e.peerId } : undefined;
      case 'disconnected':
        if (e.peerId === null || !mine.delete(e.peerId)) return undefined;
        this.conns.delete(e.peerId);
        return { type: 'closed', connId: e.peerId, reason: String(e.reason) };
      case 'state':
        return {
          type: 'state',
          online: e.state.running,
          detail: { ...e.state },
        };
      default:
        return undefined;
    }
  }

  private wrap(peer: MeshPeer): MeshConn {
    const transport = this.transport;
    return {
      connId: peer.peerId,
      path: 'nearby',
      maxFrameBytes: this.maxFrameBytes,
      peer,
      send(frame: Uint8Array, _lane: Lane): SendResult {
        let r: ReturnType<MeshTransport['send']>;
        try {
          r = transport.send(peer.peerId, frame);
        } catch {
          return 'closed';
        }
        if (r.ok) return 'ok';
        if (r.reason === 'backpressure') return 'backpressure';
        // A frame the mesh refuses as too large would leave a hole in the
        // session's counter stream: hang up rather than skip it.
        if (r.reason === 'too-large') transport.disconnect(peer.peerId);
        return 'closed';
      },
      close(_why: string): void {
        transport.disconnect(peer.peerId);
      },
      ban(ms: number): void {
        transport.ban(peer.peerId, ms);
      },
    };
  }
}
