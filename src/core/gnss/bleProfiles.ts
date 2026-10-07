/**
 * Serial-over-BLE GATT profiles for external GNSS receivers (#588).
 *
 * The native transport (modules/inukshuk-gnss) keeps no UUID list of its
 * own: every connect sends the profiles, in priority order, and the native
 * side picks the first one the receiver offers (a profile that cannot write
 * is used read-only as a last resort). Adding a receiver family is therefore
 * a JS change that can ship over the air.
 *
 * - Nordic UART Service (NUS): the de-facto BLE serial port. ESP32 bridges
 *   (ArduSimple BT+BLE bridge, SparkFun RTK firmware's BLE serial) and most
 *   DIY u-blox kits use it (research GNSS.md §1.3, §2).
 * - Microchip "Transparent UART" (ISSC, RN487x / BM7x modules) and the HM-10
 *   style FFE0/FFE1 service: the two other common serial-module profiles.
 *   Included so such receivers work without a release; not yet verified on
 *   a specific GNSS product.
 */

export interface GattProfile {
  /** Stable id, reported back by the native side once connected. */
  name: string;
  service: string;
  /** Characteristic the receiver notifies its output on (NMEA/UBX/RTCM). */
  notify: string;
  /** Characteristic we write to (UBX configuration, RTCM corrections). */
  write: string | null;
}

/** Nordic UART: RX (6E400002) is what WE write; TX (6E400003) notifies. */
export const NORDIC_UART: GattProfile = {
  name: 'nordic-uart',
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
};

export const MICROCHIP_TRANSPARENT_UART: GattProfile = {
  name: 'microchip-transparent-uart',
  service: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  notify: '49535343-1e4d-4bd9-ba61-23c647249616',
  write: '49535343-8841-43f4-a8d4-ecbe34729bb3',
};

/** HM-10 and clones: one characteristic (FFE1) both notifies and is written. */
export const HM10_SERIAL: GattProfile = {
  name: 'hm10-serial',
  service: '0000ffe0-0000-1000-8000-00805f9b34fb',
  notify: '0000ffe1-0000-1000-8000-00805f9b34fb',
  write: '0000ffe1-0000-1000-8000-00805f9b34fb',
};

export const DEFAULT_GNSS_PROFILES: readonly GattProfile[] = [
  NORDIC_UART,
  MICROCHIP_TRANSPARENT_UART,
  HM10_SERIAL,
];

const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHORT = /^(?:[0-9a-f]{4}|[0-9a-f]{8})$/;

/**
 * Lower-case 128-bit UUID; 16/32-bit short forms ("FFE0") expand on the
 * Bluetooth base UUID. Same rule as the native side (GattProfiles.kt,
 * GnssCore.swift). Null when not a UUID.
 */
export function normalizeUuid(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (FULL.test(s)) return s;
  if (SHORT.test(s)) return (s.length === 4 ? `0000${s}` : s) + BASE_SUFFIX;
  return null;
}

/** The first profile whose service a device advertises, if any. */
export function advertisedProfile(
  serviceUuids: readonly string[],
  profiles: readonly GattProfile[] = DEFAULT_GNSS_PROFILES,
): GattProfile | null {
  const advertised = new Set(serviceUuids.map(normalizeUuid).filter((u) => u !== null));
  return profiles.find((p) => advertised.has(p.service)) ?? null;
}

export interface RankableDevice {
  id: string;
  name: string | null;
  rssi: number | null;
  serviceUuids: readonly string[];
}

/**
 * Order for a "choose your receiver" list: devices advertising a known
 * serial profile first, then named devices, then by signal strength, then
 * by name. Stable for equal keys. Unnamed devices that advertise nothing we
 * know are most likely headphones, beacons or TVs; they stay listed (a
 * receiver may advertise its service only in the scan response) but last.
 */
export function rankDevices<T extends RankableDevice>(
  devices: readonly T[],
  profiles: readonly GattProfile[] = DEFAULT_GNSS_PROFILES,
): T[] {
  const key = (d: T) => ({
    known: advertisedProfile(d.serviceUuids, profiles) ? 0 : 1,
    named: d.name && d.name.trim() !== '' ? 0 : 1,
    rssi: d.rssi ?? -1000,
  });
  return devices
    .map((d, i) => ({ d, i, k: key(d) }))
    .sort(
      (a, b) =>
        a.k.known - b.k.known ||
        a.k.named - b.k.named ||
        b.k.rssi - a.k.rssi ||
        (a.d.name ?? '').localeCompare(b.d.name ?? '') ||
        a.i - b.i,
    )
    .map((x) => x.d);
}
