import { pointReadoutText } from './pointReadout';

// Fixed epoch: 2026-08-09 is a Sunday; build a local-time 14:00 timestamp so
// formatTimelineLabel (device-local by design) is deterministic in the test.
const SUN_1400 = new Date(2026, 7, 9, 14, 0, 0, 0).getTime();

describe('pointReadoutText', () => {
  it('formats a forecast temperature the Windy way: value · model · time', () => {
    expect(pointReadoutText('temp', 'hrdps', 14.3, false, SUN_1400)).toBe(
      '14° · HRDPS · Sun 14:00',
    );
  });

  it('converts temperature for imperial units', () => {
    expect(pointReadoutText('temp', 'gdps', 10, true, SUN_1400)).toBe('50° · GDPS · Sun 14:00');
  });

  it('wind converts m/s to km/h (or mph) with the unit label', () => {
    expect(pointReadoutText('wind', 'rdps', 10, false, SUN_1400)).toBe(
      '36 km/h · RDPS · Sun 14:00',
    );
    expect(pointReadoutText('wind', 'rdps', 10, true, SUN_1400)).toBe('22 mph · RDPS · Sun 14:00');
  });

  it('precip stays metric with one decimal', () => {
    expect(pointReadoutText('precip', 'hrdps', 1.26, true, SUN_1400)).toBe(
      '1.3 mm · HRDPS · Sun 14:00',
    );
  });

  it('radar layers drop the model segment and use the legend unit', () => {
    expect(pointReadoutText('radar-rain', 'hrdps', 2.44, false, SUN_1400)).toBe(
      '2.4 mm/h · Sun 14:00',
    );
    expect(pointReadoutText('radar-snow', 'gdps', 0.5, false, SUN_1400)).toBe(
      '0.5 cm/h · Sun 14:00',
    );
  });

  it('omits the time segment when no frame time is known', () => {
    expect(pointReadoutText('temp', 'hrdps', -3.6, false, null)).toBe('-4° · HRDPS');
    expect(pointReadoutText('radar-rain', 'hrdps', 1, false, null)).toBe('1 mm/h');
  });
});
