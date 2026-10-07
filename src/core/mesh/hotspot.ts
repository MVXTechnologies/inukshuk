/**
 * Where to dial when discovery finds nobody (#589): the hotspot fallback.
 *
 * A phone joined to a hotspot reaches the hotspot phone at its default
 * gateway, and every Inukshuk listens on the well-known port first
 * (`MESH_DEFAULT_PORT`). Android reports the real gateway; iOS has no API
 * for it, so the subnet's `.1` stands in: an iPhone Personal Hotspot is
 * 172.20.10.1 and Android hotspots hand out their own `.1`. The phone that IS
 * the hotspot has nothing to dial — it waits for the others.
 */

export const MESH_DEFAULT_PORT = 47321;

export interface MeshInterface {
  name: string;
  address: string;
  prefixLength: number;
}

export interface MeshNetworkInfo {
  interfaces: MeshInterface[];
  /** Wi-Fi default gateways (Android only; empty on iOS). */
  gateways: string[];
  /** This phone's listening port, when the mesh runs. */
  port: number | null;
}

export interface DialCandidate {
  host: string;
  port: number;
  why: 'gateway' | 'subnet-first-host';
}

export function parseIPv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

export function formatIPv4(value: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(value / 2 ** s) % 256).join('.');
}

/** Private (RFC 1918) addresses: the only ones a LAN or hotspot hands out. */
export function isPrivateIPv4(value: number): boolean {
  const a = Math.floor(value / 2 ** 24);
  const b = Math.floor(value / 2 ** 16) % 256;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Hosts to try, best first, deduplicated, never this phone's own addresses.
 * Only private IPv4 subnets of /16 to /30 are considered: a hotspot or home
 * LAN, never a cellular or public address.
 */
export function hotspotCandidates(
  info: MeshNetworkInfo,
  port = MESH_DEFAULT_PORT,
): DialCandidate[] {
  const own = new Set(info.interfaces.map((i) => i.address));
  const out: DialCandidate[] = [];
  const seen = new Set<string>();
  const add = (host: string, why: DialCandidate['why']): void => {
    if (own.has(host) || seen.has(host)) return;
    seen.add(host);
    out.push({ host, port, why });
  };
  for (const g of info.gateways) {
    const v = parseIPv4(g);
    if (v !== null && isPrivateIPv4(v)) add(g, 'gateway');
  }
  for (const i of info.interfaces) {
    const v = parseIPv4(i.address);
    if (v === null || !isPrivateIPv4(v) || i.prefixLength < 16 || i.prefixLength > 30) continue;
    const size = 2 ** (32 - i.prefixLength);
    const network = Math.floor(v / size) * size;
    add(formatIPv4(network + 1), 'subnet-first-host');
  }
  return out;
}

/** True when this phone looks like the hotspot itself (it holds its subnet's `.1`). */
export function looksLikeHotspotHost(info: MeshNetworkInfo): boolean {
  return info.interfaces.some((i) => {
    const v = parseIPv4(i.address);
    if (v === null || !isPrivateIPv4(v) || i.prefixLength < 16 || i.prefixLength > 30) return false;
    const size = 2 ** (32 - i.prefixLength);
    return v % size === 1;
  });
}
