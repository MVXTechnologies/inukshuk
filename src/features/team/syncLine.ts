/** One-line sync status for the team rows and chips (#589). */
import { shortAge } from '@core/teamui/positions';
import type { PeerStatus } from '@data/team/teamSession';

/** Teammate phones with an open sync session (deduplicated by member). */
export function openPeers(peers: readonly PeerStatus[]): PeerStatus[] {
  const seen = new Set<string>();
  return peers.filter((p) => {
    if (p.phase !== 'open' || p.memberId === null || seen.has(p.memberId)) return false;
    seen.add(p.memberId);
    return true;
  });
}

export function teamSyncLine(peers: readonly PeerStatus[], meshRunning: boolean): string {
  if (!meshRunning) return 'not syncing';
  const n = openPeers(peers).length;
  if (n === 0) return 'looking for teammates nearby';
  return `syncing with ${n} phone${n === 1 ? '' : 's'}`;
}

/** "Connected · 12 kB ↓ 3 kB ↑" / "Last synced 4 min ago" / "Not seen yet". */
export function memberSyncLine(
  memberId: string,
  peers: readonly PeerStatus[],
  lastSeenAt: number | null,
  now: number,
): string {
  const p = openPeers(peers).find((x) => x.memberId === memberId);
  if (p) return `Connected · ${kb(p.bytesIn)} in · ${kb(p.bytesOut)} out`;
  if (lastSeenAt === null) return 'Not seen yet';
  const age = shortAge(now - lastSeenAt);
  return age === 'now' ? 'Last seen just now' : `Last seen ${age} ago`;
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
