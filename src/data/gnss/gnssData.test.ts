import { resetSecureStoreForTests } from '@data/secureStore';
import { requireOptionalNativeModule } from 'expo';

import { gnssSecrets } from './credentials';
import {
  gnssLink,
  gnssLinkAvailable,
  resetGnssLinkForTests,
  simulatedReceiverEnabled,
} from './link';
import { ntripSocketFactory, resetNtripSocketForTests } from './ntripSocket';
import { SimulatedLink, simulatedFrames, simulatedLink } from './simulatedLink';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn(() => null) }));

beforeEach(() => {
  resetGnssLinkForTests();
  resetNtripSocketForTests();
  resetSecureStoreForTests();
  // Only the secure-store module is in this "binary" (no GNSS module).
  jest
    .mocked(requireOptionalNativeModule)
    .mockImplementation((name: string) => (name === 'ExpoSecureStore' ? {} : null));
});

/** The in-memory keychain (jest.setup.ts). */
const keychain = () => (globalThis as { __secureStore?: Map<string, string> }).__secureStore;

describe('caster passwords', () => {
  it('live in secure storage, one key each, listed for clear(); never in a file', async () => {
    await gnssSecrets.set('p1', 's3cret');
    await gnssSecrets.set('p2', 'other');
    await gnssSecrets.set('p1', 'changed');
    expect(await gnssSecrets.get('p1')).toBe('changed');
    expect(keychain()?.get('inukshuk.ntrip.pw.p1')).toBe('changed');
    expect(keychain()?.get('inukshuk.ntrip.index')).toBe('["p1","p2"]');
    await gnssSecrets.remove('p1');
    expect(await gnssSecrets.get('p1')).toBeNull();
    expect(keychain()?.get('inukshuk.ntrip.index')).toBe('["p2"]');
    await gnssSecrets.clear();
    expect(await gnssSecrets.get('p2')).toBeNull();
    expect(keychain()?.size).toBe(0);
  });

  it('a junk index reads as empty; without secure storage, saving fails loudly', async () => {
    keychain()?.set('inukshuk.ntrip.index', '{nope');
    await gnssSecrets.clear();
    keychain()?.set('inukshuk.ntrip.index', '{"a":1}');
    await gnssSecrets.set('p', 'x');
    expect(keychain()?.get('inukshuk.ntrip.index')).toBe('["p"]');
    resetSecureStoreForTests();
    jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
    await expect(gnssSecrets.set('p', 'x')).rejects.toThrow(/securely/);
    expect(await gnssSecrets.get('p')).toBeNull();
    await gnssSecrets.remove('p');
  });
});

describe('the receiver link of this build', () => {
  it('debug builds (Jest) get the simulated receiver when the native module is absent', () => {
    expect(simulatedReceiverEnabled()).toBe(true);
    expect(gnssLink()).toBe(simulatedLink());
    expect(gnssLinkAvailable()).toBe(true);
    expect(ntripSocketFactory()?.kind).toBe('simulated');
  });

  it('the native module wins when the binary has it', () => {
    const native = { openTcp: jest.fn() };
    jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
    expect(gnssLink()).toBe(native);
    expect(ntripSocketFactory()?.kind).toBe('native');
  });

  it('the simulated session is the scripted Québec run, one chunk per epoch', () => {
    expect(simulatedFrames()).toHaveLength(150);
    expect(atob(simulatedFrames()[0] ?? '')).toMatch(/^\$GNGGA,120000\.00,4648\.18/);
  });

  it('the simulated link refuses writes until connected', async () => {
    const l = new SimulatedLink();
    await expect(l.write(new Uint8Array(1))).rejects.toThrow('E_GNSS_NOT_CONNECTED');
    expect(await l.getKnownDevices()).toEqual([]);
    expect((await l.requestPermissionsAsync()).granted).toBe(true);
    expect((await l.getAvailability()).transports).toEqual(['fake']);
    await l.disconnect();
    expect(l.getState().state).toBe('idle');
  });
});

describe('the native TCP seam (NTRIP)', () => {
  function nativeTcp() {
    const listeners: Record<
      string,
      (e: { id: string; data?: string; error?: string | null }) => void
    > = {};
    const mod = {
      openTcp: jest.fn(async () => 'sock-1'),
      writeTcp: jest.fn(async () => undefined),
      closeTcp: jest.fn(async () => undefined),
      addListener: jest.fn((event: string, l: (typeof listeners)[string]) => {
        listeners[event] = l;
        return { remove: jest.fn() };
      }),
    };
    return {
      mod,
      emit: (event: string, e: { id: string; data?: string; error?: string | null }) =>
        listeners[event]?.(e),
    };
  }

  it('moves bytes both ways and reports the close', async () => {
    const { mod, emit } = nativeTcp();
    jest.mocked(requireOptionalNativeModule).mockReturnValue(mod);
    const f = ntripSocketFactory();
    const data: number[][] = [];
    const closed: (string | null)[] = [];
    const s = f?.open('caster.example', 2101, false, {
      onData: (b) => data.push([...b]),
      onClose: (e) => closed.push(e),
    });
    await s?.write(new Uint8Array([1, 2]));
    expect(mod.openTcp).toHaveBeenCalledWith({ host: 'caster.example', port: 2101, tls: false });
    expect(mod.writeTcp).toHaveBeenCalledWith('sock-1', new Uint8Array([1, 2]));
    emit('onTcpData', { id: 'other', data: 'AQI=' });
    emit('onTcpData', { id: 'sock-1', data: 'AQI=' });
    expect(data).toEqual([[1, 2]]);
    emit('onTcpClose', { id: 'sock-1', error: 'reset' });
    emit('onTcpClose', { id: 'sock-1', error: 'again' });
    expect(closed).toEqual(['reset']);
    s?.close();
    expect(mod.closeTcp).not.toHaveBeenCalled();
  });

  it('a failed open is a close with its reason; close() closes the socket', async () => {
    const { mod } = nativeTcp();
    mod.openTcp.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    jest.mocked(requireOptionalNativeModule).mockReturnValue(mod);
    const closed: (string | null)[] = [];
    const s = ntripSocketFactory()?.open('h', 1, false, {
      onData: jest.fn(),
      onClose: (e) => closed.push(e),
    });
    await s?.write(new Uint8Array([1]));
    expect(closed).toEqual(['ECONNREFUSED']);
    expect(mod.writeTcp).not.toHaveBeenCalled();
    resetNtripSocketForTests();
    const ok = ntripSocketFactory()?.open('h', 1, false, { onData: jest.fn(), onClose: jest.fn() });
    ok?.close();
    ok?.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(mod.closeTcp).toHaveBeenCalledTimes(1);
  });
});
