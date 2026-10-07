import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import { createNativeMeshTransport, nativeMeshAvailable } from './meshNative';
import { MeshTransportError, type MeshEvent } from './meshTransport';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn() }));

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakeNative() {
  const handlers = new Map<string, (p: Record<string, unknown>) => void>();
  let inbox: { peerId: string; data: Uint8Array }[] = [];
  const native = {
    defaultPort: 47321,
    serviceType: '_inukshuk-team._tcp',
    maxFrameCeiling: 1 << 20,
    start: jest.fn(async () => ({ port: 47321, alreadyRunning: false })),
    stop: jest.fn(async () => undefined),
    startAdvertising: jest.fn(async () => undefined),
    stopAdvertising: jest.fn(),
    startBrowsing: jest.fn(async () => undefined),
    stopBrowsing: jest.fn(),
    connect: jest.fn(() => 'd1'),
    connectService: jest.fn(() => 'd2'),
    disconnect: jest.fn(),
    send: jest.fn((): number => 9),
    takeFrames: jest.fn((max: number) => {
      const out = inbox.slice(0, max);
      inbox = inbox.slice(max);
      return out;
    }),
    ban: jest.fn(),
    getStats: jest.fn(() => ({ running: true, peers: [] })),
    getState: jest.fn(() => ({
      running: true,
      port: 47321,
      advertising: false,
      browsing: false,
      localNetwork: 'granted',
    })),
    getNetworkInfo: jest.fn(() => ({ interfaces: [], gateways: ['192.168.43.1'], port: 47321 })),
    addListener: jest.fn((name: string, fn: (p: Record<string, unknown>) => void) => {
      handlers.set(name, fn);
      return { remove: () => handlers.delete(name) };
    }),
  };
  const fire = (name: string, payload: Record<string, unknown> = {}): void =>
    handlers.get(name)?.(payload);
  const push = (frames: { peerId: string; data: Uint8Array }[]): void => {
    inbox = inbox.concat(frames);
  };
  return { native, fire, push, handlers };
}

beforeEach(() => {
  Platform.OS = 'android';
});

it('is absent from binaries built before the module', () => {
  jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
  expect(nativeMeshAvailable()).toBe(false);
  expect(createNativeMeshTransport()).toBeNull();
  Platform.OS = 'web';
  jest.mocked(requireOptionalNativeModule).mockReturnValue({});
  expect(nativeMeshAvailable()).toBe(false);
});

it('maps native events and drains every frame in order, before a disconnect', async () => {
  const { native, fire, push, handlers } = fakeNative();
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const t = createNativeMeshTransport();
  if (!t) throw new Error('expected a transport');
  const events: MeshEvent[] = [];
  t.subscribe((e) => events.push(e));
  await expect(t.start({ maxPeers: 8 })).resolves.toEqual({ port: 47321 });
  expect(native.start).toHaveBeenCalledWith({ maxPeers: 8 });

  fire('onConnected', {
    peerId: 'p1',
    dialId: 'd1',
    host: '192.168.43.1',
    port: 47321,
    direction: 'out',
  });
  // 200 frames: more than one batch.
  push(Array.from({ length: 200 }, (_, i) => ({ peerId: 'p1', data: Uint8Array.of(i % 256) })));
  fire('onFramesAvailable');
  push([{ peerId: 'p1', data: Uint8Array.of(7) }]);
  fire('onDisconnected', { peerId: 'p1', dialId: 'd1', reason: 'remote-closed', retryInMs: 1200 });
  fire('onPeerFound', { serviceId: 'ink-abc', tag: 'tagtagtag', host: null, port: null });
  fire('onPeerLost', { serviceId: 'ink-abc' });
  fire('onWritable', { peerId: 'p1' });
  fire('onError', { code: 'E_MESH_LOCAL_NETWORK_DENIED', message: 'off' });
  fire('onStateChanged', { running: true });
  fire('onStats', { running: true, peers: [] });

  expect(events[0]).toEqual({
    type: 'connected',
    peer: { peerId: 'p1', dialId: 'd1', host: '192.168.43.1', port: 47321, direction: 'out' },
  });
  const frames = events.filter((e) => e.type === 'frame');
  expect(frames).toHaveLength(201);
  expect(frames.map((e) => (e.type === 'frame' ? e.data[0] : -1)).slice(0, 3)).toEqual([0, 1, 2]);
  const disconnectAt = events.findIndex((e) => e.type === 'disconnected');
  expect(disconnectAt).toBe(202);
  expect(events[disconnectAt]).toEqual({
    type: 'disconnected',
    peerId: 'p1',
    dialId: 'd1',
    reason: 'remote-closed',
    retryInMs: 1200,
  });
  expect(events.map((e) => e.type).slice(203)).toEqual([
    'peer-found',
    'peer-lost',
    'writable',
    'error',
    'state',
    'stats',
  ]);

  await t.stop();
  expect(handlers.size).toBe(0);
});

it('flags a frame that lost its bytes on the bridge', async () => {
  const { native, fire, push } = fakeNative();
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const t = createNativeMeshTransport();
  const events: MeshEvent[] = [];
  t?.subscribe((e) => events.push(e));
  await t?.start();
  push([{ peerId: 'p1', data: undefined as unknown as Uint8Array }]);
  fire('onFramesAvailable');
  expect(events).toEqual([{ type: 'error', code: 'E_MESH_BRIDGE', message: expect.any(String) }]);
});

it('turns expected send refusals into results and other failures into coded errors', () => {
  const { native } = fakeNative();
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const t = createNativeMeshTransport();
  if (!t) throw new Error('expected a transport');
  expect(t.send('p1', Uint8Array.of(1))).toEqual({ ok: true, queuedBytes: 9 });
  for (const [code, reason] of [
    ['E_MESH_BACKPRESSURE', 'backpressure'],
    ['E_MESH_NO_PEER', 'no-peer'],
    ['E_MESH_FRAME_TOO_LARGE', 'too-large'],
  ] as const) {
    native.send.mockImplementationOnce(() => {
      throw coded(code);
    });
    expect(t.send('p1', Uint8Array.of(1))).toEqual({ ok: false, reason });
  }
  native.send.mockImplementationOnce(() => {
    throw coded('E_MESH_NOT_RUNNING');
  });
  expect(() => t.send('p1', Uint8Array.of(1))).toThrow(MeshTransportError);

  expect(t.connect('192.168.43.1', 47321, { reconnect: true })).toBe('d1');
  expect(native.connect).toHaveBeenCalledWith('192.168.43.1', 47321, true);
  expect(t.connectService('ink-abc')).toBe('d2');
  expect(native.connectService).toHaveBeenCalledWith('ink-abc', false);
  native.connect.mockImplementationOnce(() => {
    throw coded('E_MESH_ARGUMENT');
  });
  let caught: unknown;
  try {
    t.connect('', 1);
  } catch (e) {
    caught = e;
  }
  expect(caught).toMatchObject({ code: 'E_MESH_ARGUMENT' });

  t.disconnect('d1');
  t.ban('p1', 600_000);
  t.stopAdvertising();
  t.stopBrowsing();
  void t.startAdvertising('tagtagtag');
  void t.startBrowsing(null);
  expect(native.ban).toHaveBeenCalledWith('p1', 600_000);
  expect(native.startBrowsing).toHaveBeenCalledWith(null);
  expect(t.stats()).toEqual({ running: true, peers: [] });
  expect(t.state().localNetwork).toBe('granted');
  expect(t.networkInfo().gateways).toEqual(['192.168.43.1']);
});
