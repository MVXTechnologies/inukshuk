/**
 * The NTRIP connection's socket — THE MISSING NATIVE PIECE.
 *
 * NTRIP 1.0 isn't valid HTTP (`ICY 200 OK`), and both versions stream for
 * hours, so neither `fetch` nor WebSocket can carry it: it needs a raw TCP
 * (optionally TLS) socket. The app has none today (no `react-native-tcp-socket`,
 * and `modules/inukshuk-gnss` reserves a `tcp` transport but doesn't
 * implement it). This file is the seam:
 *
 * - `NtripSocketFactory.open(host, port, tls)` → a byte pipe with data /
 *   close / error callbacks; the protocol (request bytes, response parsing,
 *   GGA upload, forwarding RTCM to the receiver) stays in `@core/gnss/ntrip`
 *   and `@features/gnss/ntripClient`, so the native side only moves bytes;
 * - the native module plugs in by exposing `openTcp` / `writeTcp` /
 *   `closeTcp` + `onTcpData` / `onTcpClose` events (see `nativeTcp` below);
 * - until then a store build reports "corrections need an app update", and
 *   debug / E2E builds get a simulated caster (sourcetable + a correction
 *   stream) so the profile editor and the sourcetable browser work end to end.
 */
import { asciiToBytes } from '@core/gnss/bytes';
import { requireOptionalNativeModule } from 'expo';

import { simulatedReceiverEnabled } from './link';

export interface NtripSocketHandlers {
  onData(bytes: Uint8Array): void;
  /** The caster closed, or the connection failed (`error` set). */
  onClose(error: string | null): void;
}

export interface NtripSocket {
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export interface NtripSocketFactory {
  /** Where the bytes go: 'native' TCP, or the 'simulated' caster. */
  kind: 'native' | 'simulated';
  open(host: string, port: number, tls: boolean, handlers: NtripSocketHandlers): NtripSocket;
}

// ---- native (when the module provides it) ----------------------------------------------------

interface NativeTcp {
  openTcp(options: { host: string; port: number; tls: boolean }): Promise<string>;
  writeTcp(id: string, data: Uint8Array): Promise<void>;
  closeTcp(id: string): Promise<void>;
  addListener(
    event: 'onTcpData' | 'onTcpClose',
    listener: (e: { id: string; data?: string; error?: string | null }) => void,
  ): { remove(): void };
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function nativeFactory(mod: NativeTcp): NtripSocketFactory {
  return {
    kind: 'native',
    open(host, port, tls, h) {
      let id: string | null = null;
      let closed = false;
      const subs = [
        mod.addListener('onTcpData', (e) => {
          if (e.id === id && e.data) h.onData(base64Bytes(e.data));
        }),
        mod.addListener('onTcpClose', (e) => {
          if (e.id !== id || closed) return;
          closed = true;
          for (const s of subs) s.remove();
          h.onClose(e.error ?? null);
        }),
      ];
      const opened = mod.openTcp({ host, port, tls }).then(
        (sid) => {
          id = sid;
          return sid;
        },
        (err: unknown) => {
          closed = true;
          for (const s of subs) s.remove();
          h.onClose(err instanceof Error ? err.message : String(err));
          return null;
        },
      );
      return {
        async write(bytes) {
          const sid = await opened;
          if (sid !== null && !closed) await mod.writeTcp(sid, bytes);
        },
        close() {
          if (closed) return;
          closed = true;
          for (const s of subs) s.remove();
          void opened.then((sid) => (sid === null ? undefined : mod.closeTcp(sid)));
        },
      };
    },
  };
}

// ---- simulated caster (debug / E2E builds) ----------------------------------------------------

/**
 * A sourcetable of three clearly-simulated bases around Québec City (not
 * real stations), so the nearest-first ranking has something to rank.
 */
export const SIMULATED_SOURCETABLE = [
  'SOURCETABLE 200 OK',
  'Content-Type: text/plain',
  '',
  'STR;SIM_LEVIS;Levis (simulated);RTCM 3.3;1005(10),1077(1),1087(1),1097(1),1127(1);2;GPS+GLO+GAL+BDS;SIM;CAN;46.80;-71.18;0;0;Simulated;none;N;N;9600;simulated base',
  'STR;SIM_BEAUPORT;Beauport (simulated);RTCM 3.3;1005(10),1077(1),1127(1);2;GPS+BDS;SIM;CAN;46.87;-71.19;0;0;Simulated;none;N;N;9600;simulated base',
  'STR;SIM_NETWORK;Quebec network VRS (simulated);RTCM 3.2;1005(10),1074(1),1084(1);2;GPS+GLO;SIM;CAN;46.81;-71.22;1;1;Simulated;none;B;N;9600;simulated VRS',
  'STR;SIM_CMR;Legacy CMR (simulated);CMR+;;2;GPS;SIM;CAN;46.79;-71.21;0;0;Simulated;none;N;N;9600;not RTCM 3',
  'ENDSOURCETABLE',
  '',
].join('\r\n');

/** A placeholder correction burst a second (the simulated receiver ignores it). */
const SIM_RTCM = new Uint8Array([0xd3, 0x00, 0x13, 0x3e, 0xd0, 0x00, 0x03]);

function simulatedFactory(): NtripSocketFactory {
  return {
    kind: 'simulated',
    open(_host, _port, _tls, h) {
      let closed = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      let request = '';
      const end = (err: string | null) => {
        if (closed) return;
        closed = true;
        if (timer !== null) clearInterval(timer);
        h.onClose(err);
      };
      return {
        async write(bytes) {
          if (closed) return;
          if (timer !== null) return; // GGA uploads while streaming
          request += String.fromCharCode(...bytes);
          if (!request.includes('\r\n\r\n')) return;
          const mount = /^GET \/(\S*) /.exec(request)?.[1] ?? '';
          setTimeout(() => {
            if (closed) return;
            if (mount === '') {
              h.onData(asciiToBytes(SIMULATED_SOURCETABLE));
              end(null);
              return;
            }
            h.onData(asciiToBytes('ICY 200 OK\r\n\r\n'));
            timer = setInterval(() => h.onData(SIM_RTCM), 1000);
          }, 200);
        },
        close() {
          end(null);
        },
      };
    },
  };
}

let cached: NtripSocketFactory | null | undefined;

/**
 * This build's socket for NTRIP: native TCP when the binary has it, the
 * simulated caster in debug / E2E builds, else null ("needs an app update").
 */
export function ntripSocketFactory(): NtripSocketFactory | null {
  if (cached !== undefined) return cached;
  const mod = requireOptionalNativeModule<Partial<NativeTcp>>('InukshukGnss');
  if (mod && typeof mod.openTcp === 'function') cached = nativeFactory(mod as NativeTcp);
  else cached = simulatedReceiverEnabled() ? simulatedFactory() : null;
  return cached;
}

/** Test-only. */
export function resetNtripSocketForTests(): void {
  cached = undefined;
}
