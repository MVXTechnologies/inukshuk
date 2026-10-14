import type { HeroData } from '@core/recording/panel';

import { METRIC, NOW, QC, snapshot } from '../testUtils';
import {
  HERO_DESCENT,
  HERO_DISTANCE,
  HERO_GAIN,
  HERO_MOVING,
  HERO_PACE,
  HERO_TIME,
} from './recording';

const REC: HeroData = {
  elapsedS: 4360,
  distanceM: 8420,
  ascentM: 412,
  descentM: 188,
  movingTimeS: 3490,
  avgSpeedMps: 1.056,
  liveSpeedMps: 1,
  altitudeM: 412,
  position: QC,
  nowMs: NOW,
};

describe('hero fields', () => {
  const data = snapshot({ recording: REC });

  it("format exactly as the recording panel's hero row", () => {
    expect(HERO_TIME.compute(data, {}, METRIC)).toEqual({ glyph: 'timer', value: '1:12:40' });
    expect(HERO_DISTANCE.compute(data, {}, METRIC)).toEqual({
      glyph: 'straighten',
      value: '8.42',
      unit: 'km',
    });
    expect(HERO_GAIN.compute(data, {}, METRIC)).toEqual({
      glyph: 'north_east',
      value: '+412',
      unit: 'm',
    });
    expect(HERO_DESCENT.compute(data, {}, METRIC)).toEqual({
      glyph: 'south_east',
      value: '−188',
      unit: 'm',
    });
    expect(HERO_PACE.compute(data, {}, METRIC)).toEqual({ tag: 'Pace', value: '15:47/km' });
    expect(HERO_MOVING.compute(data, {}, METRIC)).toEqual({
      glyph: 'directions_walk',
      value: '58:10',
    });
  });

  it('show only while recording', () => {
    expect(HERO_TIME.compute(snapshot(), {}, METRIC)).toBeNull();
  });

  it('carry their metric for the de-dup rule and preview in strip style', () => {
    expect(HERO_GAIN.recordingMetric).toBe('gain');
    expect(HERO_GAIN.id).toBe('hero:gain');
    expect(HERO_PACE.sample).toEqual({ tag: 'Pace', value: '15:47/km' });
  });
});
