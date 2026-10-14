import { estimateWidthDp, fitStripValue, VALUE_SMALL_SP, VALUE_SP } from './fit';
import { SAMPLE_SUBJECT } from './fields/navigation';
import { sampleValue } from './preview';
import { fieldDescriptor, FIELDS } from './registry';
import {
  CAPTION_MIN_CHARS,
  captionMinWidthDp,
  captionPlan,
  fitCell,
  spokenField,
  SUBJECT_ICON_DP,
  unfittedCell,
} from './subject';
import { METRIC } from './testUtils';
import type { StripSubject, StripValue } from './types';

const LAC: StripSubject = {
  key: 'waypoint:w1',
  name: 'Lac-Beauport',
  glyph: 'place',
  pin: { icon: 'camp', color: '#E8612C' },
};
const DIST: StripValue = { value: '3.20', unit: 'km', subject: LAC };
const ETE: StripValue = { tag: 'ETE', value: '0:21', subject: LAC };
const BEARING: StripValue = { glyph: 'explore', value: '042°', unit: 'NE', subject: LAC };
const NAME: StripValue = {
  glyph: 'place',
  value: 'Lac-Beauport',
  subject: LAC,
  namesSubject: true,
};

const d = (id: string) => {
  const out = fieldDescriptor(id);
  if (out === undefined) throw new Error(id);
  return out;
};

/** The width at which a cell just captions its subject, dp. */
const captionAt = (v: StripValue, fontScale = 1) =>
  SUBJECT_ICON_DP +
  captionMinWidthDp(v.subject!.name, fontScale) +
  estimateWidthDp(v, VALUE_SP, fontScale);

describe('fitCell: name, else icon, never a cut number', () => {
  it('a field with no subject fits as before', () => {
    const v: StripValue = { glyph: 'speed', value: '3.6', unit: 'km/h' };
    expect(fitCell(v, 40)).toEqual({ ...fitStripValue(v, 40), subject: 'none' });
  });

  it('names the subject when the whole value fits beside a few letters of it', () => {
    const at = captionAt(DIST);
    expect(fitCell(DIST, at)).toEqual({
      value: DIST,
      valueSp: VALUE_SP,
      shrinkToFit: true,
      subject: 'caption',
    });
    // One dp short: the icon alone, the value whole.
    const narrower = fitCell(DIST, at - 1);
    expect(narrower.subject).toBe('icon');
    expect(narrower.value.value).toBe('3.20');
  });

  it('a larger font needs a wider cell to name it', () => {
    const at = captionAt(DIST);
    expect(fitCell(DIST, at, 1.3).subject).toBe('icon');
    expect(fitCell(DIST, captionAt(DIST, 1.3), 1.3).subject).toBe('caption');
  });

  it('a short name needs only its own letters, a long one a few and the ellipsis', () => {
    expect(captionMinWidthDp('Lac')).toBeLessThan(captionMinWidthDp('Lac-Beauport'));
    expect(captionMinWidthDp('Lac-Beauport')).toBe(captionMinWidthDp('Kiosque Edwin-Bélanger'));
    expect(captionMinWidthDp('x'.repeat(CAPTION_MIN_CHARS + 1))).toBe(
      captionMinWidthDp('x'.repeat(CAPTION_MIN_CHARS + 40)),
    );
  });

  it('not allowed to name it (named elsewhere): the icon, however wide the cell', () => {
    expect(fitCell(DIST, 400, 1, false).subject).toBe('icon');
    expect(fitCell(DIST, 400, 1, false).value).toEqual(DIST);
  });

  it("in the icon's room the value gives up what fitStripValue would, never its digits", () => {
    for (const v of [DIST, ETE, BEARING]) {
      for (const w of [20, 40, 60, 80]) {
        const f = fitCell(v, w);
        expect(f.subject).toBe('icon');
        expect(f).toEqual({ ...fitStripValue(v, w - SUBJECT_ICON_DP), subject: 'icon' });
        expect(f.value.value).toBe(v.value);
        expect(f.shrinkToFit).toBe(true);
      }
    }
    // ETE keeps its tag (no glyph names it), the bearing loses its compass point first.
    expect(fitCell(ETE, 80).value.tag).toBe('ETE');
    expect(fitCell(BEARING, 55).value.unit).toBeUndefined();
  });

  it("the name field: the subject's icon in the glyph's place, then ellipsised as any name", () => {
    const wide = fitCell(NAME, 300);
    expect(wide.subject).toBe('icon');
    expect(wide.value).toEqual({ value: 'Lac-Beauport', subject: LAC, namesSubject: true });
    const narrow = fitCell(NAME, 40);
    expect(narrow.subject).toBe('icon');
    expect(narrow.valueSp).toBe(VALUE_SMALL_SP);
    expect(narrow.shrinkToFit).toBe(false);
  });

  it('before layout (or in a content-sized box): the icon, the value whole', () => {
    expect(unfittedCell(DIST)).toEqual({
      value: DIST,
      valueSp: VALUE_SP,
      shrinkToFit: false,
      subject: 'icon',
    });
    expect(unfittedCell(NAME).value.glyph).toBeUndefined();
    expect(unfittedCell({ value: '1.2' }).subject).toBe('none');
  });
});

describe('captionPlan: a subject is named once per strip', () => {
  const OTHER: StripSubject = { key: 'destination', name: 'Destination', glyph: 'flag' };

  it('the first field to it names it; the others show its icon', () => {
    expect(captionPlan([[DIST, ETE], [BEARING]])).toEqual([[true, false], [false]]);
  });

  it('a target-name field names it: no field to it repeats the name, in any row', () => {
    expect(captionPlan([[DIST], [NAME, ETE]])).toEqual([[false], [false, false]]);
    expect(captionPlan([[NAME, DIST]])).toEqual([[false, false]]);
  });

  it('each target is named by its own first field', () => {
    const toOther: StripValue = { ...DIST, subject: OTHER };
    expect(captionPlan([[DIST, toOther, { ...ETE, subject: OTHER }]])).toEqual([
      [true, true, false],
    ]);
  });

  it('cells without a subject, and cells not drawn, never caption', () => {
    expect(captionPlan([[{ value: '1.2' }, null, DIST]])).toEqual([[false, false, true]]);
    expect(captionPlan([])).toEqual([]);
  });
});

describe('spokenField: says what a reading is to', () => {
  it('"Distance to Lac-Beauport: 3.2 km" and the like', () => {
    expect(spokenField(d('targetDistance'), { ...DIST, value: '3.2' })).toBe(
      'Distance to Lac-Beauport: 3.2 km',
    );
    expect(spokenField(d('ete'), ETE)).toBe('Time to Lac-Beauport: 0:21');
    expect(spokenField(d('eta'), { tag: 'ETA', value: '14:32', subject: LAC })).toBe(
      'Arrival at Lac-Beauport: 14:32',
    );
    expect(spokenField(d('targetBearing'), BEARING)).toBe('Bearing to Lac-Beauport: 042° NE');
    const off: StripValue = {
      value: 'Off 62',
      unit: 'm',
      subject: { key: 'trail', name: 'Sentier des Caps', glyph: 'route' },
    };
    expect(spokenField(d('offTrail'), off)).toBe('Distance back to Sentier des Caps: Off 62 m');
  });

  it('any other field (and the name field) as before: label, tag, value, unit', () => {
    expect(spokenField(d('targetName'), NAME)).toBe('Target name Lac-Beauport');
    expect(spokenField(d('ete'), { tag: 'ETE', value: '0:21' })).toBe(
      'Time to target (ETE) ETE 0:21',
    );
    expect(spokenField(d('speed'), { glyph: 'speed', value: '3.6', unit: 'km/h' })).toBe(
      'Speed 3.6 km/h',
    );
  });

  it('every field that can carry a subject says it out loud', () => {
    for (const f of Object.values(FIELDS)) {
      const s = sampleValue(f, METRIC.units);
      if (s.subject !== undefined && s.namesSubject !== true) {
        expect({ id: f.id, spokenTo: f.spokenTo !== undefined }).toEqual({
          id: f.id,
          spokenTo: true,
        });
      }
    }
    expect(d('offTrail').spokenTo).toBeDefined();
  });
});

describe('the presets show what the map will (samples carry their target)', () => {
  it('every target field samples the same made-up target, named once', () => {
    const ids = ['targetName', 'targetDistance', 'targetBearing', 'ete', 'eta'];
    for (const id of ids) expect(sampleValue(d(id), METRIC.units).subject).toBe(SAMPLE_SUBJECT);
    const row = ['targetDistance', 'ete'].map((id) => sampleValue(d(id), METRIC.units));
    expect(captionPlan([row])).toEqual([[true, false]]);
    const withName = ['targetName', 'targetDistance'].map((id) => sampleValue(d(id), METRIC.units));
    expect(captionPlan([withName])).toEqual([[false, false]]);
  });
});
