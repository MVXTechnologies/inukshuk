import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import type { MeshNetworkInfo } from '@core/mesh/hotspot';

import {
  MeshListeners,
  MeshTransportError,
  type MeshConfigInput,
  type MeshEvent,
  type MeshPeer,
  type MeshService,
  type MeshState,
  type MeshStats,
  type MeshTransport,
  type SendResult,
} from './meshTransport';

/** The native module's surface (modules/inukshuk-mesh, both platforms). */
interface NativeMesh {
  readonly defaultPort: number;
  readonly serviceType: string;
  readonly maxFrameCeiling: number;
  start(config: MeshConfigInput | null): Promise<{ port: number; alreadyRunning: boolean }>;
  stop(): Promise<void>;
  startAdvertising(tag: string): Promise<void>;
  stopAdvertising(): void;
  startBrowsing(tag: string | null): Promise<void>;
  stopBrowsing(): void;
  connect(host: string, port: number, reconnect: boolean): string;
  connectService(serviceId: string, reconnect: boolean): string;
  disconnect(id: string): void;
  send(peerId: string, data: Uint8Array): number;
  takeFrames(max: number): { peerId: string; data: Uint8Array }[];
  ban(peerId: string, durationMs: number): void;
  getStats(): MeshStats;
  getState(): MeshState;
  getNetworkInfo(): MeshNetworkInfo;
  addListener(
    event: string,
    listener: (payload: Record<string, unknown>) => void,
  ): { remove(): void };
}

function nativeModule(): NativeMesh | null {
  return Platform.OS === 'android' || Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativeMesh>('InukshukMesh')
    : null;
}

/** False on binaries built before the module (older store builds, OTA recipients) and on web. */
export function nativeMeshAvailable(): boolean {
  return nativeModule() !== null;
}

/** Frames pulled per bridge call: bounded so one call never copies an unbounded inbox. */
const TAKE_BATCH = 128;

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Wraps the native module. Frames are pulled on 'onFramesAvailable', in order. */
export class NativeMeshTransport implements MeshTransport {
  readonly kind = 'native' as const;
  private readonly listeners = new MeshListeners();
  private subscriptions: { remove(): void }[] = [];

  constructor(private readonly native: NativeMesh) {}

  private attach(): void {
    if (this.subscriptions.length > 0) return;
    const on = (name: string, fn: (p: Record<string, unknown>) => void): void => {
      this.subscriptions.push(this.native.addListener(name, fn));
    };
    on('onFramesAvailable', () => this.drain());
    on('onConnected', (p) => {
      const peer: MeshPeer = {
        peerId: String(p['peerId']),
        dialId: str(p['dialId']),
        host: String(p['host'] ?? ''),
        port: num(p['port']) ?? 0,
        direction: p['direction'] === 'out' ? 'out' : 'in',
      };
      this.listeners.emit({ type: 'connected', peer });
    });
    on('onDisconnected', (p) => {
      // Frames received before the close are delivered before it.
      this.drain();
      this.listeners.emit({
        type: 'disconnected',
        peerId: str(p['peerId']),
        dialId: str(p['dialId']),
        reason: String(p['reason'] ?? 'io-error'),
        retryInMs: num(p['retryInMs']),
      });
    });
    on('onPeerFound', (p) => {
      const service: MeshService = {
        serviceId: String(p['serviceId']),
        tag: String(p['tag'] ?? ''),
        host: str(p['host']),
        port: num(p['port']),
      };
      this.listeners.emit({ type: 'peer-found', service });
    });
    on('onPeerLost', (p) =>
      this.listeners.emit({ type: 'peer-lost', serviceId: String(p['serviceId']) }),
    );
    on('onWritable', (p) => this.listeners.emit({ type: 'writable', peerId: String(p['peerId']) }));
    on('onError', (p) =>
      this.listeners.emit({
        type: 'error',
        code: String(p['code']),
        message: String(p['message'] ?? ''),
      }),
    );
    on('onStateChanged', (p) =>
      this.listeners.emit({ type: 'state', state: p as unknown as MeshState }),
    );
    on('onStats', (p) => this.listeners.emit({ type: 'stats', stats: p as unknown as MeshStats }));
  }

  private detach(): void {
    for (const s of this.subscriptions) s.remove();
    this.subscriptions = [];
  }

  private drain(): void {
    for (;;) {
      const batch = this.native.takeFrames(TAKE_BATCH);
      for (const f of batch) {
        if (f.data instanceof Uint8Array && f.data.length > 0) {
          this.listeners.emit({ type: 'frame', peerId: f.peerId, data: f.data });
        } else {
          this.listeners.emit({
            type: 'error',
            code: 'E_MESH_BRIDGE',
            message: 'A frame crossed the bridge without bytes',
          });
        }
      }
      if (batch.length < TAKE_BATCH) return;
    }
  }

  async start(config?: MeshConfigInput): Promise<{ port: number }> {
    this.attach();
    const { port } = await this.native.start(config ?? null);
    return { port };
  }

  async stop(): Promise<void> {
    await this.native.stop();
    this.detach();
  }

  startAdvertising(tag: string): Promise<void> {
    return this.native.startAdvertising(tag);
  }

  stopAdvertising(): void {
    this.native.stopAdvertising();
  }

  startBrowsing(tag: string | null): Promise<void> {
    return this.native.startBrowsing(tag);
  }

  stopBrowsing(): void {
    this.native.stopBrowsing();
  }

  connect(host: string, port: number, opts?: { reconnect?: boolean }): string {
    return this.wrap(() => this.native.connect(host, port, opts?.reconnect ?? false));
  }

  connectService(serviceId: string, opts?: { reconnect?: boolean }): string {
    return this.wrap(() => this.native.connectService(serviceId, opts?.reconnect ?? false));
  }

  disconnect(id: string): void {
    this.native.disconnect(id);
  }

  send(peerId: string, frame: Uint8Array): SendResult {
    try {
      return { ok: true, queuedBytes: this.native.send(peerId, frame) };
    } catch (error) {
      switch (codeOf(error)) {
        case 'E_MESH_BACKPRESSURE':
          return { ok: false, reason: 'backpressure' };
        case 'E_MESH_NO_PEER':
          return { ok: false, reason: 'no-peer' };
        case 'E_MESH_FRAME_TOO_LARGE':
          return { ok: false, reason: 'too-large' };
        default:
          throw this.toError(error);
      }
    }
  }

  ban(peerId: string, durationMs: number): void {
    this.native.ban(peerId, durationMs);
  }

  stats(): MeshStats {
    return this.native.getStats();
  }

  state(): MeshState {
    return this.native.getState();
  }

  networkInfo(): MeshNetworkInfo {
    return this.native.getNetworkInfo();
  }

  subscribe(listener: (event: MeshEvent) => void): () => void {
    return this.listeners.add(listener);
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw this.toError(error);
    }
  }

  private toError(error: unknown): MeshTransportError {
    if (error instanceof MeshTransportError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new MeshTransportError(codeOf(error) || 'E_MESH', message);
  }
}

/** The native transport, or null where the module is not in the binary. */
export function createNativeMeshTransport(): NativeMeshTransport | null {
  const native = nativeModule();
  return native ? new NativeMeshTransport(native) : null;
}
