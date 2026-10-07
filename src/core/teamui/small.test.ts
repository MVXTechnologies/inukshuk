/** System messages, colours, invites and lifetime: the small pure helpers of the team UI. */
import { encodeInvite } from '@core/team/invite';
import { c, newWorld, T0 } from '@core/team/testing/fixtures';
import { createInvite } from '@core/team/actions';

import { initials, memberColor, MEMBER_COLORS } from './colors';
import {
  DEFAULT_INVITE,
  inviteExpiresAt,
  inviteSummary,
  parseAnyInvite,
  parseHostPort,
  smsInviteText,
  appJoinLink,
  webJoinLink,
} from './invites';
import { DEFAULT_LIFETIME, expiryLine, extendedExpiry, lifetimeMs } from './lifetime';
import { cleanName, isSystemThread, MAX_NAME_CHARS, nameText, parseNameText } from './system';

const DAY = 86_400_000;

describe('system messages', () => {
  it('cleans display names', () => {
    expect(cleanName('  Julie   Tremblay ')).toBe('Julie Tremblay');
    expect(cleanName('\u202eevil\u0007')).toBe('evil');
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('x'.repeat(100))).toHaveLength(MAX_NAME_CHARS);
  });

  it('round-trips names and rejects junk without throwing', () => {
    expect(parseNameText(nameText('Ana Ruiz'))).toBe('Ana Ruiz');
    for (const junk of ['', '{', '[]', 'null', '{"n":3}', '{"n":"  "}', 'x'.repeat(500), 7]) {
      expect(parseNameText(junk)).toBeNull();
    }
    expect(isSystemThread('sys:profile')).toBe(true);
    expect(isSystemThread('team')).toBe(false);
  });
});

describe('colours and initials', () => {
  it('wraps the palette and builds initials', () => {
    expect(memberColor(0)).toBe(MEMBER_COLORS[0]);
    expect(memberColor(MEMBER_COLORS.length + 2)).toBe(MEMBER_COLORS[2]);
    expect(memberColor(-1)).toBe(MEMBER_COLORS[MEMBER_COLORS.length - 1]);
    expect(initials('Julie Tremblay')).toBe('JT');
    expect(initials('Luc')).toBe('L');
    expect(initials('Alex (Guide)')).toBe('AG');
    expect(initials('élodie de la Rive')).toBe('ÉR');
    expect(initials('')).toBe('?');
  });
});

describe('invites', () => {
  const w = newWorld();
  const inv = createInvite(c, w.teamId, { expiresAt: T0 + 2 * DAY, maxUses: 1, role: 'member' });
  const payload = encodeInvite(inv.token, 'link');

  it('parses every form a user can bring', () => {
    for (const text of [
      payload,
      ` ${payload}\n`,
      webJoinLink(payload),
      appJoinLink(payload),
      `inukshuk://team/join#${payload}`,
      `Join “Relevé” on Inukshuk: ${webJoinLink(payload)}`,
    ]) {
      expect(parseAnyInvite(text)?.teamId).toBe(w.teamId);
    }
    expect(parseAnyInvite('')).toBeUndefined();
    expect(parseAnyInvite('https://example.com/j#nope')).toBeUndefined();
    expect(parseAnyInvite('x'.repeat(5000))).toBeUndefined();
  });

  it('defaults to 48 h single use and never outlives the team', () => {
    expect(DEFAULT_INVITE).toEqual({ expiry: '48h', uses: 1, role: 'member', approve: 'any' });
    expect(inviteExpiresAt(DEFAULT_INVITE, T0, T0 + 14 * DAY)).toBe(T0 + 2 * DAY);
    expect(inviteExpiresAt({ ...DEFAULT_INVITE, expiry: '30d' }, T0, T0 + 14 * DAY)).toBe(
      T0 + 14 * DAY,
    );
    expect(inviteSummary(DEFAULT_INVITE)).toBe('Single use · 48 hours · joins as member');
    expect(inviteSummary({ ...DEFAULT_INVITE, uses: 25, role: 'guest', approve: 'admin' })).toBe(
      'Up to 25 people · 48 hours · joins as guest · an admin must be there',
    );
  });

  it('fits an SMS invite in one segment', () => {
    const text = smsInviteText('Relevé sentiers · Mont-Sainte-Anne', payload);
    expect(text).toContain(webJoinLink(payload));
    expect(text.length).toBeLessThanOrEqual(160);
    expect(smsInviteText('x'.repeat(80), payload)).toContain('…');
  });

  it('parses a typed address for the hotspot fallback', () => {
    expect(parseHostPort('172.20.10.1', 47321)).toEqual({ host: '172.20.10.1', port: 47321 });
    expect(parseHostPort(' 192.168.43.1:5000 ', 47321)).toEqual({
      host: '192.168.43.1',
      port: 5000,
    });
    for (const bad of ['', '300.1.1.1', '1.2.3', '1.2.3.4:0', '1.2.3.4:70000', 'host:1']) {
      expect(parseHostPort(bad, 47321)).toBeNull();
    }
  });
});

describe('lifetime', () => {
  const max = T0 + 365 * DAY;
  it('defaults to 14 days and extends from now or the expiry, capped', () => {
    expect(lifetimeMs(DEFAULT_LIFETIME)).toBe(14 * DAY);
    expect(extendedExpiry(T0 + DAY, 7, T0, max)).toBe(T0 + 8 * DAY);
    // An expired team is revived for N days from now.
    expect(extendedExpiry(T0 - 5 * DAY, 3, T0, max)).toBe(T0 + 3 * DAY);
    expect(extendedExpiry(max - DAY, 14, T0, max)).toBe(max);
    expect(extendedExpiry(max, 3, T0, max)).toBeNull();
  });

  it('says when the team ends', () => {
    expect(expiryLine(T0 + 13.2 * DAY, T0, false)).toBe('Ends in 14 days');
    expect(expiryLine(T0 + 3_600_000, T0, false)).toMatch(/^Ends at \d\d:\d\d$/);
    expect(expiryLine(T0 - 1000, T0, false)).toBe('Ended today · read-only');
    expect(expiryLine(T0 - 2.5 * DAY, T0, false)).toBe('Ended 2 days ago · read-only');
    expect(expiryLine(T0 + DAY * 3, T0, true)).toBe('Closed by an admin · read-only');
  });
});
