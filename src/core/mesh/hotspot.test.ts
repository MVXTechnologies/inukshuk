import {
  formatIPv4,
  hotspotCandidates,
  isPrivateIPv4,
  looksLikeHotspotHost,
  MESH_DEFAULT_PORT,
  parseIPv4,
  type MeshNetworkInfo,
} from './hotspot';

const info = (over: Partial<MeshNetworkInfo>): MeshNetworkInfo => ({
  interfaces: [],
  gateways: [],
  port: null,
  ...over,
});

describe('IPv4 helpers', () => {
  it('parses and formats', () => {
    expect(parseIPv4('192.168.43.1')).toBe(0xc0a82b01);
    expect(formatIPv4(0xc0a82b01)).toBe('192.168.43.1');
    for (const bad of ['', '1.2.3', '1.2.3.256', 'a.b.c.d', '1.2.3.4.5', '01234.1.1.1']) {
      expect(parseIPv4(bad)).toBeNull();
    }
  });

  it('knows the private ranges', () => {
    const p = (s: string): boolean => isPrivateIPv4(parseIPv4(s) ?? 0);
    expect(p('10.1.2.3') && p('172.16.0.1') && p('172.31.255.1') && p('192.168.1.1')).toBe(true);
    expect(p('172.32.0.1') || p('8.8.8.8') || p('100.64.0.1')).toBe(false);
  });
});

describe('hotspotCandidates', () => {
  it('puts the Android gateway first, then the subnet .1 (iPhone hotspot)', () => {
    const c = hotspotCandidates(
      info({
        gateways: ['192.168.43.1'],
        interfaces: [
          { name: 'wlan0', address: '192.168.43.57', prefixLength: 24 },
          { name: 'en0', address: '172.20.10.3', prefixLength: 28 },
        ],
      }),
    );
    expect(c).toEqual([
      { host: '192.168.43.1', port: MESH_DEFAULT_PORT, why: 'gateway' },
      { host: '172.20.10.1', port: MESH_DEFAULT_PORT, why: 'subnet-first-host' },
    ]);
  });

  it('never dials itself, public or cellular addresses, or odd prefixes', () => {
    const c = hotspotCandidates(
      info({
        gateways: ['8.8.8.8', '10.0.0.1'],
        interfaces: [
          { name: 'ap0', address: '10.0.0.1', prefixLength: 24 },
          { name: 'rmnet0', address: '100.70.1.2', prefixLength: 30 },
          { name: 'wlan0', address: '10.5.0.9', prefixLength: 8 },
        ],
      }),
      1234,
    );
    expect(c).toEqual([]);
  });

  it('spots the hotspot phone itself', () => {
    const one = (address: string): MeshNetworkInfo =>
      info({ interfaces: [{ name: 'bridge100', address, prefixLength: 28 }] });
    expect(looksLikeHotspotHost(one('172.20.10.1'))).toBe(true);
    expect(looksLikeHotspotHost(one('172.20.10.3'))).toBe(false);
    expect(looksLikeHotspotHost(one('bad'))).toBe(false);
  });
});
