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
    expect(sampleValue(d('eta'), clock)).toEqual({ tag: 'ETA', value: '14h32' });
    expect(sampleValue(d('sunset'), clock).value).toBe('18h12');
    expect(sampleValue(d('tides:nextHigh'), clock).value).toBe('14h52');
  });

  it('keeps any other sample as declared, and no sample names a real tide station', () => {
    expect(sampleValue(d('targetDistance'))).toBe(d('targetDistance').sample);
    expect(d('tides:level').sample.tag).toBe('Tide');
  });
});
