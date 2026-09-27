import { GPS_LOST_MS } from '../geo/track/gpsQuality';
import { gpsChip } from './gpsChip';

const NOW = 1_800_000_000_000;

describe('gpsChip', () => {
  it('states the accuracy when the signal is good', () => {
    expect(gpsChip('good', 4.6, NOW - 1000, NOW)).toEqual({ kind: 'ok', label: 'GPS ±5 m' });
  });

  it('never claims better than ±1 m', () => {
    expect(gpsChip('good', 0.2, NOW, NOW).label).toBe('GPS ±1 m');
  });

  it('says only GPS when the platform gave no accuracy', () => {
    expect(gpsChip('good', null, NOW, NOW).label).toBe('GPS');
  });

  it('names a weak signal with its accuracy', () => {
    expect(gpsChip('weak', 35, NOW - 9000, NOW)).toEqual({
      kind: 'weak',
      label: 'Weak GPS · ±35 m',
    });
    expect(gpsChip('weak', null, NOW - 9000, NOW).label).toBe('Weak GPS');
  });

  it('says how long the signal has been lost', () => {
    expect(gpsChip('lost', 12, NOW - 2 * 60_000, NOW)).toEqual({
      kind: 'lost',
      label: 'No GPS · 2 min',
    });
    expect(gpsChip('lost', 12, NOW - 45_000, NOW).label).toBe('No GPS · 45 s');
    expect(gpsChip('lost', 12, NOW - 3 * 3_600_000, NOW).label).toBe('No GPS · 3 h');
  });

  it('falls back to the lost threshold when there never was a fix', () => {
    expect(gpsChip('lost', null, null, NOW).label).toBe(`No GPS · ${GPS_LOST_MS / 1000} s`);
  });

  it('says it is still looking before the first fix', () => {
    expect(gpsChip('acquiring', null, null, NOW)).toEqual({
      kind: 'acquiring',
      label: 'Finding GPS…',
    });
  });
});
