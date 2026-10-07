import {
  advertisedProfile,
  DEFAULT_GNSS_PROFILES,
  HM10_SERIAL,
  MICROCHIP_TRANSPARENT_UART,
  normalizeUuid,
  NORDIC_UART,
  rankDevices,
} from './bleProfiles';

describe('normalizeUuid', () => {
  it('lower-cases full UUIDs and expands short forms on the base UUID', () => {
    expect(normalizeUuid(' 6E400001-B5A3-F393-E0A9-E50E24DCCA9E ')).toBe(NORDIC_UART.service);
    expect(normalizeUuid('FFE0')).toBe(HM10_SERIAL.service);
    expect(normalizeUuid('0000ffe0')).toBe(HM10_SERIAL.service);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'nus', '12345', 'ffe0-', '6e400001b5a3f393e0a9e50e24dcca9e']) {
      expect(normalizeUuid(bad)).toBeNull();
    }
  });
});

describe('default profiles', () => {
  it('are already normalised (the native side compares them verbatim)', () => {
    for (const p of DEFAULT_GNSS_PROFILES) {
      expect(normalizeUuid(p.service)).toBe(p.service);
      expect(normalizeUuid(p.notify)).toBe(p.notify);
      expect(p.write === null || normalizeUuid(p.write) === p.write).toBe(true);
    }
  });

  it('put Nordic UART first and have unique names', () => {
    expect(DEFAULT_GNSS_PROFILES[0]).toBe(NORDIC_UART);
    const names = DEFAULT_GNSS_PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('advertisedProfile', () => {
  it('finds the profile of an advertised service in any spelling', () => {
    expect(advertisedProfile(['FFE0'])).toBe(HM10_SERIAL);
    expect(
      advertisedProfile([
        '0000180f-0000-1000-8000-00805f9b34fb',
        '49535343-FE7D-4AE5-8FA9-9FAFD205E455',
      ]),
    ).toBe(MICROCHIP_TRANSPARENT_UART);
  });

  it('follows the profile priority, not the advertisement order', () => {
    expect(advertisedProfile(['ffe0', NORDIC_UART.service])).toBe(NORDIC_UART);
  });

  it('returns null for unknown or malformed services', () => {
    expect(advertisedProfile([])).toBeNull();
    expect(advertisedProfile(['180f', 'garbage'])).toBeNull();
  });
});

describe('rankDevices', () => {
  const dev = (
    id: string,
    name: string | null,
    rssi: number | null,
    serviceUuids: string[] = [],
  ) => ({
    id,
    name,
    rssi,
    serviceUuids,
  });

  it('lists known receivers first, then named devices, then by signal', () => {
    const ranked = rankDevices([
      dev('tv', null, -40),
      dev('headset', 'Headset', -50),
      dev('far-kit', 'RTK kit B', -90, [NORDIC_UART.service]),
      dev('near-kit', 'RTK kit A', -60, [NORDIC_UART.service]),
      dev('quiet', 'Zed', null),
    ]);
    expect(ranked.map((d) => d.id)).toEqual(['near-kit', 'far-kit', 'headset', 'quiet', 'tv']);
  });

  it('breaks ties by name, then keeps the input order', () => {
    const ranked = rankDevices([
      dev('b', 'Beta', -70),
      dev('a', 'Alpha', -70),
      dev('a2', 'Alpha', -70),
    ]);
    expect(ranked.map((d) => d.id)).toEqual(['a', 'a2', 'b']);
  });

  it('does not mutate its input', () => {
    const input = [dev('x', null, -90), dev('y', 'Y', -10)];
    rankDevices(input);
    expect(input.map((d) => d.id)).toEqual(['x', 'y']);
  });
});
