/**
 * The mesh around one team session or one join (#589): starts the transport,
 * advertises the team's discovery tag (members only — a joiner only
 * browses), dials every teammate it discovers, and remembers manual dials
 * (the hotspot fallback). Owns no sync logic: connections become sync
 * sessions in a `MeshSessionHost`.
 *
 * One link at a time uses the app's transport; stopping it stops the
 * transport (sockets, listener, mDNS), which is what backgrounding needs.
 */
import { MESH_DEFAULT_PORT } from '@core/mesh/hotspot';

import type { MeshEvent, MeshState, MeshTransport } from './meshTransport';

export interface MeshLinkStatus {
  running: boolean;
  port: number | null;
  advertising: boolean;
  browsing: boolean;
  localNetwork: MeshState['localNetwork'];
  /** Teammates' phones seen on the network (mDNS). */
  discovered: number;
  /** The last transport error, for the UI ("Local Network is off"). */
  error: { code: string; message: string } | null;
}

export const LOCAL_NETWORK_DENIED = 'E_MESH_LOCAL_NETWORK_DENIED';

export class MeshLink {
  private readonly services = new Map<string, string>();
  private readonly manual = new Map<string, string>();
  /** oneAtATime: services waiting their turn, and the one being dialled. */
  private readonly queue: string[] = [];
  private current: { serviceId: string; dialId: string } | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private error: MeshLinkStatus['error'] = null;

  constructor(
    private readonly transport: MeshTransport,
    private readonly options: {
      tag: string;
      advertise: boolean;
      onChange: () => void;
      /**
       * Dial discovered phones one at a time (a joiner): two members admitting
       * the same single-use invite at once would race (spec §8.4).
       */
      oneAtATime?: boolean;
      /** Diagnostics: event kinds and reasons, never addresses or ids. */
      onDiag?: (event: string) => void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.transport.subscribe((e) => this.onEvent(e));
    try {
      await this.transport.start({ preferredPort: MESH_DEFAULT_PORT });
      if (!this.running) return;
      if (this.options.advertise) await this.transport.startAdvertising(this.options.tag);
      await this.transport.startBrowsing(this.options.tag);
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown };
      this.error = {
        code: typeof err.code === 'string' ? err.code : 'E_MESH',
        message: typeof err.message === 'string' ? err.message : String(e),
      };
    }
    this.options.onChange();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const id of [...this.services.values(), ...this.manual.values()]) {
      this.transport.disconnect(id);
    }
    this.services.clear();
    this.manual.clear();
    this.queue.length = 0;
    this.current = null;
    try {
      this.transport.stopAdvertising();
      this.transport.stopBrowsing();
      await this.transport.stop();
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.options.onChange();
    }
  }

  /** Dial a typed or hinted address, retrying with backoff until stopped. */
  dial(host: string, port: number): string | null {
    if (!this.running) return null;
    const key = `${host}:${port}`;
    const existing = this.manual.get(key);
    if (existing !== undefined) return existing;
    try {
      // One at a time (a joiner): no retries, the queue moves on instead; a
      // typed or hinted address goes first.
      const single = this.options.oneAtATime === true;
      if (single && this.current !== null) {
        const old = this.current;
        this.current = null;
        this.services.delete(old.serviceId);
        this.transport.disconnect(old.dialId);
        if (!old.serviceId.startsWith('manual:')) this.queue.unshift(old.serviceId);
      }
      const id = this.transport.connect(host, port, { reconnect: !single });
      this.manual.set(key, id);
      if (single) this.current = { serviceId: `manual:${key}`, dialId: id };
      this.options.onChange();
      return id;
    } catch (e) {
      this.error = { code: 'E_MESH_DIAL', message: String((e as Error).message ?? e) };
      this.options.onChange();
      return null;
    }
  }

  /** Stop retrying a manual address. */
  undial(host: string, port: number): void {
    const key = `${host}:${port}`;
    const id = this.manual.get(key);
    if (id === undefined) return;
    this.manual.delete(key);
    this.transport.disconnect(id);
    this.options.onChange();
  }

  get manualDials(): string[] {
    return [...this.manual.keys()];
  }

  status(): MeshLinkStatus {
    let state: MeshState | null = null;
    try {
      state = this.transport.state();
    } catch {
      state = null;
    }
    const denied = state?.localNetwork === 'denied' || this.error?.code === LOCAL_NETWORK_DENIED;
    return {
      running: this.running && (state?.running ?? false),
      port: state?.port ?? null,
      advertising: state?.advertising ?? false,
      browsing: state?.browsing ?? false,
      localNetwork: denied ? 'denied' : (state?.localNetwork ?? 'unknown'),
      discovered: this.services.size,
      error: this.error,
    };
  }

  private dialService(serviceId: string): void {
    try {
      // One at a time: no automatic retry; the queue moves on instead.
      const dialId = this.transport.connectService(serviceId, {
        reconnect: this.options.oneAtATime !== true,
      });
      this.services.set(serviceId, dialId);
      if (this.options.oneAtATime) this.current = { serviceId, dialId };
    } catch {
      // The service vanished between discovery and dial: the next advert retries.
    }
  }

  private onEvent(e: MeshEvent): void {
    if (!this.running) return;
    switch (e.type) {
      case 'peer-found': {
        this.options.onDiag?.('found');
        const id = e.service.serviceId;
        if (this.services.has(id) || this.queue.includes(id)) return;
        if (e.service.tag !== this.options.tag) return;
        if (this.options.oneAtATime && this.current !== null) this.queue.push(id);
        else this.dialService(id);
        this.options.onChange();
        return;
      }
      case 'peer-lost': {
        this.options.onDiag?.('lost');
        const q = this.queue.indexOf(e.serviceId);
        if (q >= 0) this.queue.splice(q, 1);
        const dial = this.services.get(e.serviceId);
        if (dial === undefined) return;
        this.services.delete(e.serviceId);
        this.transport.disconnect(dial);
        this.options.onChange();
        return;
      }
      case 'error':
        this.options.onDiag?.(`error ${e.code}`);
        this.error = { code: e.code, message: e.message };
        this.options.onChange();
        return;
      case 'disconnected':
        this.options.onDiag?.(
          `disconnected ${e.reason}${e.retryInMs !== null ? ' (retrying)' : ''}`,
        );
        if (
          this.options.oneAtATime &&
          this.current !== null &&
          e.dialId === this.current.dialId &&
          e.retryInMs === null
        ) {
          // That phone is done with us (refused, or gone): try the next one, and
          // come back to this one last.
          const { serviceId } = this.current;
          this.services.delete(serviceId);
          this.current = null;
          if (serviceId.startsWith('manual:')) this.manual.delete(serviceId.slice(7));
          const next = this.queue.shift();
          if (!serviceId.startsWith('manual:')) this.queue.push(serviceId);
          if (next !== undefined && next !== serviceId) this.dialService(next);
        }
        this.options.onChange();
        return;
      case 'state':
      case 'connected':
        this.options.onChange();
        return;
      default:
        return;
    }
  }
}
