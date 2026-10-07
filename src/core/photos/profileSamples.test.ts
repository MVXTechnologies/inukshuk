import { profilePaths, sampleProfile } from './profileSamples';
import type { ViewerTrail } from './viewerInfo';

const trail: ViewerTrail = {
  axisCumM: [0, 100, 200],
  elevations: [500, 600, 500],
  totalM: 200,
};

describe('sampleProfile', () => {
  it('samples evenly along the axis', () => {
    expect(sampleProfile(trail, 5)).toEqual([500, 550, 600, 550, 500]);
  });

  it('keeps gaps where there is no altitude', () => {
    expect(sampleProfile({ ...trail, elevations: [undefined, undefined, 500] }, 3)).toEqual([
      null,
      500,
      500,
    ]);
    expect(sampleProfile({ ...trail, elevations: [500, undefined, 600] }, 3)).toEqual([
      500, 600, 600,
    ]);
  });

  it('is empty without points', () => {
    expect(sampleProfile({ axisCumM: [], elevations: [], totalM: 0 })).toEqual([]);
    expect(sampleProfile(trail, 1)).toEqual([]);
  });

  it('copes with a zero-length step', () => {
    expect(sampleProfile({ axisCumM: [0, 0, 10], elevations: [1, 2, 3], totalM: 10 }, 2)).toEqual([
      2, 3,
    ]);
  });
});

describe('profilePaths', () => {
  it('draws a line and its area, breaking at gaps', () => {
    const { line, area } = profilePaths([0, 10, null, 5, 5], 40, 20, 0);
    expect(line).toBe('M0.0 20.0 L10.0 0.0 M30.0 10.0 L40.0 10.0');
    expect(area).toContain('Z');
  });

  it('draws nothing without data or room', () => {
    expect(profilePaths([null, null], 40, 20)).toEqual({ line: '', area: '' });
    expect(profilePaths([1, 2], 0, 20)).toEqual({ line: '', area: '' });
  });

  it('draws a flat profile mid-height-ish without dividing by zero', () => {
    expect(profilePaths([5, 5], 10, 10, 0).line).toBe('M0.0 10.0 L10.0 10.0');
  });
});
