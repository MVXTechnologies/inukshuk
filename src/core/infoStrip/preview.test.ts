import { IMPERIAL, METRIC, NAUTICAL } from '@core/format';

import { placeholderValue, PLACEHOLDER_TEXT, sampleValue } from './preview';
import { fieldDescriptor, FIELDS } from './registry';
import type { FieldDescriptor } from './types';

const d = (id: string) => {
  const out = fieldDescriptor(id);
  if (out === undefined) throw new Error(id);
  return out;
};

describe('placeholderValue (QA 2.6.0: no made-up value reads as live)', () => {
  it('is "—" behind the glyph or tag, with no unit and no tone', () => {
    expect(placeholderValue(d('targetName'))).toEqual({ glyph: 'flag', value: '—' });
    expect(placeholderValue(d('eta'))).toEqual({ tag: 'ETA', value: '—' });
    expect(placeholderValue(d('offTrail'))).toEqual({ glyph: 'route', value: '—' });
    expect(placeholderValue(d('targetDistance'))).toEqual({ glyph: 'straighten', value: '—' });
    expect(placeholderValue(d('tides:level'))).toEqual({ glyph: 'waves', tag: 'Tide', value: '—' });
  });

  it('every field has one that says what it is (a glyph or a tag)', () => {
    for (const f of Object.values(FIELDS) as FieldDescriptor[]) {
      const p = placeholderValue(f);
      expect(p.value).toBe(PLACEHOLDER_TEXT);
      expect(p.unit).toBeUndefined();
      expect(p.tone).toBeUndefined();
      expect(p.glyph !== undefined || p.tag !== undefined).toBe(true);
    }
  });
});

describe('sampleValue (the presets: clock samples in the phone 12/24 h form)', () => {
  it('formats a clock sample with the given clock at its local time', () => {
    const clock = (ms: number) => {
      const t = new Date(ms);
      return `${t.getHours()}h${t.getMinutes()}`;
    };
    expect(sampleValue(d('eta'), METRIC, clock)).toEqual({ tag: 'ETA', value: '14h32' });
    expect(sampleValue(d('sunset'), METRIC, clock).value).toBe('18h12');
    expect(sampleValue(d('tides:nextHigh'), METRIC, clock).value).toBe('14h52');
  });

  it('keeps any other sample as declared, and no sample names a real tide station', () => {
    expect(sampleValue(d('heading'), IMPERIAL)).toBe(d('heading').sample);
    expect(d('tides:level').sample.tag).toBe('Tide');
  });
});

describe('sampleValue in the user units (#702: a miniature never reads km/h to an mph user)', () => {
  it('metric reads as the declared sample', () => {
    for (const id of ['targetDistance', 'speed', 'elevation', 'altitude', 'tides:level']) {
      expect({ id, v: sampleValue(d(id), METRIC) }).toEqual({ id, v: d(id).sample });
    }
  });

  it('imperial and nautical go through the units formatter', () => {
    expect(sampleValue(d('targetDistance'), IMPERIAL)).toEqual({ value: '0.76', unit: 'mi' });
    expect(sampleValue(d('speed'), IMPERIAL)).toEqual({
      glyph: 'speed',
      value: '2.2',
      unit: 'mph',
    });
    expect(sampleValue(d('speed'), NAUTICAL)).toEqual({ glyph: 'speed', value: '1.9', unit: 'kn' });
    expect(sampleValue(d('elevation'), IMPERIAL)).toEqual({
      glyph: 'terrain',
      value: '≈696',
      unit: 'ft',
    });
    expect(sampleValue(d('altitude'), IMPERIAL)).toEqual({
      glyph: 'landscape',
      value: '1352',
      unit: 'ft',
    });
    expect(sampleValue(d('tides:level'), IMPERIAL)).toEqual({
      glyph: 'waves',
      tag: 'Tide',
      value: '+12.60',
      unit: 'ft ↑',
    });
  });

  it('every field whose sample is a distance, height or speed converts it', () => {
    // Survey values stay metric on purpose (unitStrings.test: src/core/gnss/).
    const SURVEY = new Set(['gnss:height', 'accuracy']);
    const LENGTHY = /^(m|km|km\/h|ft|mi|mph|kn|NM)\b/;
    for (const f of Object.values(FIELDS) as FieldDescriptor[]) {
      if (SURVEY.has(f.id) || !LENGTHY.test(f.sample.unit ?? '')) continue;
      expect({ id: f.id, converts: f.sampleIn !== undefined }).toEqual({
        id: f.id,
        converts: true,
      });
    }
  });
});

describe('the recording samples (hero:*) follow the units too', () => {
  it('metric keeps the samples as they read before; imperial converts', () => {
    const v = (id: string, u = METRIC) => {
      const s = sampleValue(d(id), u);
      return `${s.value}${s.unit === undefined ? '' : ` ${s.unit}`}`;
    };
    expect(
      ['time', 'distance', 'gain', 'descent', 'pace', 'moving'].map((f) => v(`hero:${f}`)),
    ).toEqual(['1:12:40', '8.42 km', '+412 m', '−188 m', '15:47/km', '58:10']);
    expect(d('hero:distance').sample).toEqual(sampleValue(d('hero:distance'), METRIC));
    expect(['distance', 'gain', 'descent', 'pace'].map((f) => v(`hero:${f}`, IMPERIAL))).toEqual([
      '5.23 mi',
      '+1352 ft',
      '−617 ft',
      '25:24/mi',
    ]);
  });
});
