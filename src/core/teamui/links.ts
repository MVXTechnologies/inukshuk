/**
 * How each teammate is reached (2.7.0, #705): the link chip in the team
 * panel and on Manage team, and the reason line of the Connection sheet.
 * Pure: the caller hands in the open links and the path manager's status.
 */
import { shortAge } from './positions';

export type MemberLink = 'direct' | 'relay' | 'nearby' | 'connecting' | 'old' | 'out';

/** One open link to a teammate's phone that carries this team. */
export interface OpenLink {
  member: string;
  path: 'nearby' | 'direct' | 'relay';
}

/** What the path manager says of one teammate (`PeerPathStatus`). */
export interface PathView {
  member: string;
  primary: 'nearby' | 'direct' | 'relay' | undefined;
  signalling: boolean;
  /** Paths being tried. */
  connecting: boolean;
}

export interface LinkInputs {
  /** Active teammates (not me). */
  members: readonly string[];
  links: readonly OpenLink[];
  paths: readonly PathView[];
  /** The team's internet switch. */
  internetOn: boolean;
  /** Members whose app speaks internet paths (their `rtc` claim). */
  rtcCapable: ReadonlySet<string>;
}

const PREFERENCE: readonly OpenLink['path'][] = ['nearby', 'direct', 'relay'];

/** Each teammate's link, as the chips show it. */
export function memberLinks(i: LinkInputs): Map<string, MemberLink> {
  const out = new Map<string, MemberLink>();
  for (const m of i.members) {
    const open = new Set(i.links.filter((l) => l.member === m).map((l) => l.path));
    const view = i.paths.find((p) => p.member === m);
    let link: MemberLink | undefined;
    if (view?.primary !== undefined && open.has(view.primary)) link = view.primary;
    link ??= PREFERENCE.find((p) => open.has(p));
    if (link === undefined && i.internetOn) {
      if (!i.rtcCapable.has(m)) link = 'old';
      else if (view !== undefined && (view.signalling || view.connecting)) link = 'connecting';
    }
    out.set(m, link ?? 'out');
  }
  return out;
}

/** The chip's word. */
export const LINK_LABEL: Record<MemberLink, string> = {
  direct: 'Direct',
  relay: 'Relayed',
  nearby: 'Nearby',
  connecting: 'Connecting',
  old: 'Needs update',
  out: 'Out of reach',
};

/** The Connection sheet's reason line for one teammate. */
export function linkReason(
  link: MemberLink,
  o: { alwaysRelay: boolean; lastSeenAt: number | null; now: number },
): string {
  switch (link) {
    case 'direct':
      return 'Phone to phone over the internet';
    case 'relay':
      return o.alwaysRelay
        ? 'Through the relay, as you chose'
        : 'No direct path between your networks';
    case 'nearby':
      return 'Same Wi-Fi or hotspot, no internet used';
    case 'connecting':
      return 'Connecting…';
    case 'old':
      return 'Older Inukshuk · nearby only until updated';
    case 'out': {
      if (o.lastSeenAt === null) return 'Not seen yet';
      const age = shortAge(o.now - o.lastSeenAt);
      return age === 'now' ? 'Last seen just now' : `Last seen ${age} ago`;
    }
  }
}
