/**
 * Invite choices and texts (#589 UI). The protocol allows invites up to 30
 * days and 1000 uses (`membership.ts`); the UI offers a few presets with the
 * PM-decided default (spec §15 #1): **48 h, single use, member, any member
 * may admit**. Pure.
 */
import { decodeInvite, DEFAULT_INVITE_BASE, inviteLink, type InviteToken } from '@core/team/invite';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const INVITE_EXPIRY_PRESETS = [
  { id: '1h', label: '1 hour', ms: HOUR },
  { id: '48h', label: '48 hours', ms: 48 * HOUR },
  { id: '7d', label: '7 days', ms: 7 * DAY },
  { id: '30d', label: '30 days', ms: 30 * DAY },
] as const;
export type InviteExpiryId = (typeof INVITE_EXPIRY_PRESETS)[number]['id'];

export const INVITE_USE_PRESETS = [1, 5, 25, 100] as const;
export type InviteUses = (typeof INVITE_USE_PRESETS)[number];

export interface InviteChoice {
  expiry: InviteExpiryId;
  uses: InviteUses;
  role: 'member' | 'guest';
  approve: 'any' | 'admin';
}

export const DEFAULT_INVITE: InviteChoice = {
  expiry: '48h',
  uses: 1,
  role: 'member',
  approve: 'any',
};

/** When the invite stops working: never after the team itself ends. */
export function inviteExpiresAt(choice: InviteChoice, now: number, teamExpiresAt: number): number {
  const preset =
    INVITE_EXPIRY_PRESETS.find((p) => p.id === choice.expiry) ?? INVITE_EXPIRY_PRESETS[1];
  return Math.min(now + preset.ms, teamExpiresAt);
}

/** The app's own deep link (`app/team/join.tsx`); the payload is a query value, not a fragment. */
export const APP_JOIN_LINK = 'inukshuk://team/join';

export function appJoinLink(payload: string): string {
  return `${APP_JOIN_LINK}?t=${payload}`;
}

/**
 * The web link for SMS and shares: `https://inukshuk.mvxtechnologies.com/j#…`.
 * The secret stays in the fragment (browsers never send it); the page there
 * (`docs/j/index.html`) hands it to the app.
 */
export function webJoinLink(payload: string): string {
  return inviteLink(payload, DEFAULT_INVITE_BASE);
}

/**
 * The token in whatever the user scanned, pasted or opened: a bare payload,
 * the web link (`…/j#payload`), the app link (`inukshuk://team/join?t=…` or
 * `#…`). Total.
 */
export function parseAnyInvite(text: string): InviteToken | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 600) return undefined;
  const query = /[?&]t=([A-Za-z0-9_-]+)/.exec(trimmed);
  if (query?.[1] !== undefined) return decodeInvite(query[1]);
  const hash = trimmed.lastIndexOf('#');
  return decodeInvite(hash >= 0 ? trimmed.slice(hash + 1) : trimmed);
}

/** One SMS segment where possible: the name, then the link. */
export function smsInviteText(teamName: string, payload: string): string {
  const name = teamName.length > 40 ? `${teamName.slice(0, 39)}…` : teamName;
  return `Join “${name}” on Inukshuk: ${webJoinLink(payload)}`;
}

/** "Single use · 48 hours · member" */
export function inviteSummary(choice: InviteChoice): string {
  const preset = INVITE_EXPIRY_PRESETS.find((p) => p.id === choice.expiry);
  const uses = choice.uses === 1 ? 'Single use' : `Up to ${choice.uses} people`;
  const who = choice.role === 'guest' ? 'guest' : 'member';
  const approve = choice.approve === 'admin' ? ' · an admin must be there' : '';
  return `${uses} · ${preset?.label ?? ''} · joins as ${who}${approve}`;
}

/** The hint a QR may carry (QR only, never SMS or links): host/port to dial. */
export function ipv4Tuple(text: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts as [number, number, number, number];
}

/** "192.168.1.20:47321" → host and port; null when malformed. */
export function parseHostPort(
  text: string,
  defaultPort: number,
): { host: string; port: number } | null {
  const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\s*$/.exec(text);
  if (m === null || m[1] === undefined || ipv4Tuple(m[1]) === null) return null;
  const port = m[2] === undefined ? defaultPort : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}
