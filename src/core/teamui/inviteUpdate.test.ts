import { toB64u } from '@core/team/bytes';

import { inviteNeedsUpdate } from './invites';

const header = (version: number, flags: number) => {
  const b = new Uint8Array(38);
  b[0] = version;
  b[1] = flags;
  return toB64u(b);
};

describe('inviteNeedsUpdate (G7)', () => {
  it('is a newer app’s invite: a higher version or an unknown flag', () => {
    expect(inviteNeedsUpdate(`https://inukshuk.mvxtechnologies.com/j#${header(1, 4)}`)).toBe(true);
    // A shared folder's invite (flag 2) is read by this version: no update needed.
    expect(inviteNeedsUpdate(header(1, 2))).toBe(false);
    expect(inviteNeedsUpdate(header(2, 0))).toBe(true);
  });

  it('the E2E link (team-internet-shots.yaml) is a newer app’s invite', () => {
    const link =
      'https://inukshuk.mvxtechnologies.com/j#AQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(link.endsWith(header(1, 4))).toBe(true);
    expect(inviteNeedsUpdate(link)).toBe(true);
  });

  it('is not for a readable invite, nor for junk', () => {
    expect(inviteNeedsUpdate(header(1, 0))).toBe(false);
    expect(inviteNeedsUpdate('hello')).toBe(false);
    expect(inviteNeedsUpdate('')).toBe(false);
  });
});
