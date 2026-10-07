import { MESH_DEFAULT_PORT, type MeshNetworkInfo } from '@core/mesh/hotspot';

import {
  MeshListeners,
  MeshTransportError,
  type MeshConfigInput,
  type MeshEvent,
  type MeshState,
  type MeshStats,
  type MeshTransport,
  type SendResult,
} from './meshTransport';

/**
 * An in-memory mesh for dev and E2E builds (#589): several transports in one
 * JS runtime, each with a fake LAN address (10.99.0.N), that find each other
 * by tag and exchange frames asynchronously, in order — so the team UI and
 * Maestro flows can run two or more simulated peers without a network or a
 * second phone. Never selected in a store build (see `selectMeshTransport`).
 *
 * It keeps the native contract where the sync layer can tell: the frame cap,
 * a bounded send queue with 'backpressure' / 'writable', disconnects seen by
 * both sides, bans. It does not simulate timeouts, keepalives or reconnects.
 */

interface Link {
  peerId: string;
  dialId: string | null;
  owner: LoopbackMeshTransport;
  remote: Link | null;
  host: string;
  port: number;
  direction: 'in' | 'out';
  queued: number;
  wantWritable: boolean;
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
  open: boolean;
}

export interface LoopbackHubOptions {
  /** How work is deferred (tests pass a manual queue). Default: setTimeout 0. */
  schedule?: (fn: () => void) => void;
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
}

export class LoopbackMeshHub {
  readonly schedule: (fn: () => void) => void;
  readonly maxFrameBytes: number;
  readonly maxQueuedBytes: number;
  private readonly transports: LoopbackMeshTransport[] = [];
  private nextId = 0;

  constructor(options: LoopbackHubOptions = {}) {
    this.schedule = options.schedule ?? ((fn) => setTimeout(fn, 0));
    this.maxFrameBytes = options.maxFrameBytes ?? 512 * 1024;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024;
  }

  /** A new simulated phone on the hub's LAN. */
  createTransport(): LoopbackMeshTransport {
    const t = new LoopbackMeshTransport(this, `10.99.0.${this.transports.length + 2}`);
    this.transports.push(t);
    return t;
  }

  id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  find(host: string, port: number): LoopbackMeshTransport | undefined {
    return this.transports.find((t) => t.address === host && t.port === port && t.isRunning);
  }

  findService(serviceId: string): LoopbackMeshTransport | undefined {
    return this.transports.find((t) => t.serviceId === serviceId && t.isRunning);
  }

  /** Every running, advertising transport other than `self` whose tag matches. */
  services(self: LoopbackMeshTransport, tag: string | null): LoopbackMeshTransport[] {
    return this.transports.filter(
      (t) =>
        t !== self && t.isRunning && t.serviceId !== null && (tag === null || t.advertTag === tag),
    );
  }

  /** Re-announce adverts to every browser (after an advert starts or stops). */
  refreshBrowsers(): void {
    for (const t of this.transports) t.refreshBrowse();
  }
}

export class LoopbackMeshTransport implements MeshTransport {
  readonly kind = 'loopback' as const;
  readonly port = MESH_DEFAULT_PORT;
  private readonly listeners = new MeshListeners();
  private running = false;
  advertTag: string | null = null;
  serviceId: string | null = null;
  private browseTag: string | null | undefined = undefined;
  private seen = new Set<string>();
  private readonly links = new Map<string, Link>();
  private readonly banned = new Map<string, number>();

  constructor(
    private readonly hub: LoopbackMeshHub,
    readonly address: string,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  private emit(event: MeshEvent): void {
    this.hub.schedule(() => this.listeners.emit(event));
  }

  private emitState(): void {
    this.emit({ type: 'state', state: this.state() });
  }

  async start(_config?: MeshConfigInput): Promise<{ port: number }> {
    this.running = true;
    this.emitState();
    return { port: this.port };
  }

  async stop(): Promise<void> {
    for (const link of [...this.links.values()]) this.close(link, 'stopped');
    this.running = false;
    this.serviceId = null;
    this.advertTag = null;
    this.browseTag = undefined;
    this.seen.clear();
    this.hub.refreshBrowsers();
    this.emitState();
  }

  async startAdvertising(tag: string): Promise<void> {
    this.requireRunning();
    this.advertTag = tag;
    this.serviceId = this.hub.id('ink-loopback-');
    this.hub.refreshBrowsers();
    this.emitState();
  }

  stopAdvertising(): void {
    this.advertTag = null;
    this.serviceId = null;
    this.hub.refreshBrowsers();
    this.emitState();
  }

  async startBrowsing(tag: string | null): Promise<void> {
    this.requireRunning();
    this.browseTag = tag;
    this.seen.clear();
    this.refreshBrowse();
    this.emitState();
  }

  stopBrowsing(): void {
    this.browseTag = undefined;
    this.seen.clear();
    this.emitState();
  }

  refreshBrowse(): void {
    if (this.browseTag === undefined || !this.running) return;
    const now = new Map(this.hub.services(this, this.browseTag).map((t) => [t.serviceId ?? '', t]));
    for (const id of [...this.seen]) {
      if (!now.has(id)) {
        this.seen.delete(id);
        this.emit({ type: 'peer-lost', serviceId: id });
      }
    }
    for (const [id, t] of now) {
      if (this.seen.has(id) || this.banned.has(t.address)) continue;
      this.seen.add(id);
      this.emit({
        type: 'peer-found',
        service: { serviceId: id, tag: t.advertTag ?? '', host: t.address, port: t.port },
      });
    }
  }

  connect(host: string, port: number, _opts?: { reconnect?: boolean }): string {
    this.requireRunning();
    const dialId = this.hub.id('d');
    this.hub.schedule(() => this.dial(dialId, this.hub.find(host, port)));
    return dialId;
  }

  connectService(serviceId: string, _opts?: { reconnect?: boolean }): string {
    this.requireRunning();
    const target = this.hub.findService(serviceId);
    if (!target)
      throw new MeshTransportError('E_MESH_UNKNOWN_SERVICE', `No discovered service ${serviceId}`);
    const dialId = this.hub.id('d');
    this.hub.schedule(() => this.dial(dialId, target));
    return dialId;
  }

  private dial(dialId: string, target: LoopbackMeshTransport | undefined): void {
    if (!this.running) return;
    if (!target || !target.accepts(this.address)) {
      this.listeners.emit({
        type: 'disconnected',
        peerId: null,
        dialId,
        reason: 'connect-failed',
        retryInMs: null,
      });
      return;
    }
    const mine = this.addLink(dialId, target.address, target.port, 'out');
    const theirs = target.addLink(null, this.address, 40_000 + this.links.size, 'in');
    mine.remote = theirs;
    theirs.remote = mine;
    for (const link of [mine, theirs]) {
      link.owner.listeners.emit({
        type: 'connected',
        peer: {
          peerId: link.peerId,
          dialId: link.dialId,
          host: link.host,
          port: link.port,
          direction: link.direction,
        },
      });
    }
  }

  accepts(fromHost: string): boolean {
    const until = this.banned.get(fromHost);
    return this.running && (until === undefined || until <= Date.now());
  }

  addLink(dialId: string | null, host: string, port: number, direction: 'in' | 'out'): Link {
    const link: Link = {
      peerId: this.hub.id('p'),
      dialId,
      owner: this,
      remote: null,
      host,
      port,
      direction,
      queued: 0,
      wantWritable: false,
      bytesIn: 0,
      bytesOut: 0,
      framesIn: 0,
      framesOut: 0,
      open: true,
    };
    this.links.set(link.peerId, link);
    return link;
  }

  disconnect(id: string): void {
    const link = this.links.get(id) ?? [...this.links.values()].find((l) => l.dialId === id);
    if (link) this.close(link, 'local');
  }

  private close(link: Link, reason: string): void {
    if (!link.open) return;
    link.open = false;
    this.links.delete(link.peerId);
    this.emit({
      type: 'disconnected',
      peerId: link.peerId,
      dialId: link.dialId,
      reason,
      retryInMs: null,
    });
    // Like TCP: frames already sent still arrive, then the far side sees the close.
    const remote = link.remote;
    const remoteReason = reason === 'stopped' || reason === 'local' ? 'remote-closed' : 'io-error';
    if (remote?.open) this.hub.schedule(() => remote.owner.close(remote, remoteReason));
  }

  send(peerId: string, frame: Uint8Array): SendResult {
    const link = this.links.get(peerId);
    if (!link?.open || !link.remote) return { ok: false, reason: 'no-peer' };
    if (frame.length === 0)
      throw new MeshTransportError('E_MESH_ARGUMENT', 'Empty frames are reserved for keepalives');
    if (frame.length > this.hub.maxFrameBytes) return { ok: false, reason: 'too-large' };
    const size = frame.length + 4;
    if (link.queued + size > this.hub.maxQueuedBytes) {
      link.wantWritable = true;
      return { ok: false, reason: 'backpressure' };
    }
    link.queued += size;
    link.framesOut += 1;
    const copy = frame.slice();
    const remote = link.remote;
    this.hub.schedule(() => {
      link.queued -= size;
      link.bytesOut += size;
      if (remote.open) {
        remote.bytesIn += size;
        remote.framesIn += 1;
        remote.owner.listeners.emit({ type: 'frame', peerId: remote.peerId, data: copy });
      }
      if (link.open && link.wantWritable && link.queued <= this.hub.maxQueuedBytes / 4) {
        link.wantWritable = false;
        this.listeners.emit({ type: 'writable', peerId: link.peerId });
      }
    });
    return { ok: true, queuedBytes: link.queued };
  }

  ban(peerId: string, durationMs: number): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.banned.set(link.host, Date.now() + Math.min(Math.max(durationMs, 1_000), 24 * 3_600_000));
    this.close(link, 'banned');
  }

  stats(): MeshStats {
    return {
      running: this.running,
      listening: this.running,
      port: this.running ? this.port : null,
      peers: [...this.links.values()].map((l) => ({
        peerId: l.peerId,
        dialId: l.dialId,
        host: l.host,
        port: l.port,
        direction: l.direction,
        established: true,
        queuedBytes: l.queued,
        inboxBytes: 0,
        bytesIn: l.bytesIn,
        bytesOut: l.bytesOut,
        framesIn: l.framesIn,
        framesOut: l.framesOut,
        keepalivesIn: 0,
        throttled: false,
      })),
      activeBans: [...this.banned.values()].filter((t) => t > Date.now()).length,
    };
  }

  state(): MeshState {
    return {
      running: this.running,
      port: this.running ? this.port : null,
      advertising: this.advertTag !== null,
      browsing: this.browseTag !== undefined,
      localNetwork: 'granted',
    };
  }

  networkInfo(): MeshNetworkInfo {
    return {
      interfaces: [{ name: 'loopback-lan', address: this.address, prefixLength: 24 }],
      gateways: [],
      port: this.running ? this.port : null,
    };
  }

  subscribe(listener: (event: MeshEvent) => void): () => void {
    return this.listeners.add(listener);
  }

  private requireRunning(): void {
    if (!this.running)
      throw new MeshTransportError('E_MESH_NOT_RUNNING', 'The mesh is not started');
  }
}
