import { ALL_EXTENSION_KEYS, type AnyExtensionKey } from '@core/extensions/keys';
import { IMPERIAL, METRIC, NAUTICAL } from '@core/format';
import {
  DEFAULT_POINTING_LINE,
  pointingLineLengthText,
  pointingLineTicksLabel,
} from '@core/map/pointingLineSettings';

import { fitRow } from './layout';
import { paramsValid } from './params';
import {
  applyPreset,
  CURSOR_COLORS,
  DEFAULT_CURSOR,
  DEFAULT_STRIP,
  isEditedPreset,
  missingExtensions,
  presetAidsSummary,
  presetById,
  PRESETS,
  ref,
} from './presets';
import { fieldDescriptor } from './registry';
import { MAX_ROWS, type InfoStrip } from './types';

const NONE = new Set<AnyExtensionKey>();
const EVERY = new Set<AnyExtensionKey>(ALL_EXTENSION_KEYS);
const fields = (s: InfoStrip) => s.rows.map((r) => r.map((f) => f.field));

describe('DEFAULT_STRIP reproduces 2.5.1', () => {
  it('one bottom row: centre coordinates (Settings format) and centre elevation', () => {
    expect(DEFAULT_STRIP.dock).toBe('bottom');
    expect(fields(DEFAULT_STRIP)).toEqual([['coords', 'elevation']]);
    expect(DEFAULT_STRIP.rows[0]![0]!.params).toMatchObject({
      point: 'centre',
      format: 'app',
      datum: 'wgs84',
      tapToCopy: true,
    });
  });

  it("with 2.5.1's dot cursor and the pointing line left as the user set it", () => {
    expect(DEFAULT_STRIP.aids.cursor).toEqual(DEFAULT_CURSOR);
    expect(DEFAULT_CURSOR).toMatchObject({ enabled: true, kind: 'dot', size: 'S' });
    expect(CURSOR_COLORS[0]!.hex).toBe(DEFAULT_CURSOR.color);
    expect(DEFAULT_STRIP.aids.pointingLine).toBeUndefined();
  });
});

describe('the built-in presets (mockup §6)', () => {
  it('are Default, Hiking, Navigation, Survey and Paddling, in that order', () => {
    expect(PRESETS.map((p) => p.name)).toEqual([
      'Default',
      'Hiking',
      'Navigation',
      'Survey',
      'Paddling',
    ]);
    expect(presetById('survey')?.name).toBe('Survey');
    expect(presetById('nope')).toBeUndefined();
  });

  it('carry exactly the mockup rows', () => {
    const rows = Object.fromEntries(PRESETS.map((p) => [p.id, fields(p.strip)]));
    expect(rows).toEqual({
      default: [['coords', 'elevation']],
      hiking: [
        ['targetName', 'targetDistance', 'ete', 'offTrail'],
        ['altitude', 'speed', 'sunset'],
      ],
      navigation: [
        ['targetName', 'targetDistance', 'targetBearing', 'ete'],
        ['speed', 'heading', 'eta', 'declination'],
        ['coords', 'elevation'],
      ],
      survey: [
        ['coords', 'accuracy'],
        ['gnss:height', 'gnss:fix', 'declination'],
        ['targetName', 'targetDistance', 'targetBearing'],
      ],
      paddling: [
        ['speed', 'heading', 'targetName', 'targetDistance'],
        ['tides:level', 'tides:nextHigh', 'eta'],
      ],
    });
  });

  it('set the params the mockup shows', () => {
    const get = (id: string, row: number, col: number) =>
      presetById(id)!.strip.rows[row]![col]!.params;
    expect(presetById('hiking')!.strip.target).toEqual({ kind: 'nextOnTrail' });
    expect(get('survey', 0, 0)).toMatchObject({ point: 'you', format: 'ddm' });
    expect(get('paddling', 0, 0)).toMatchObject({ style: 'sog' });
    expect(get('paddling', 0, 1)).toMatchObject({ source: 'course' });
    expect(get('paddling', 0, 3)).toMatchObject({ unit: 'nmi' });
  });

  it('Survey turns on the crosshair and a 500 m pointing line ticked every 100 m', () => {
    const { aids } = presetById('survey')!.strip;
    expect(aids.cursor).toMatchObject({ kind: 'cross', size: 'M' });
    expect(aids.pointingLine).toEqual({
      ...DEFAULT_POINTING_LINE,
      enabled: true,
      length: 500,
      ticks: 100,
      labelEvery5th: true,
    });
  });

  it('are valid strips: ≤ 3 rows, rows fit, params pass their schema', () => {
    for (const p of PRESETS) {
      expect(p.strip.basedOn).toBe(p.id);
      expect(p.strip.rows.length).toBeLessThanOrEqual(MAX_ROWS);
      for (const row of p.strip.rows) {
        expect(fitRow(row).overflow).toBe(false);
        for (const f of row) {
          const d = fieldDescriptor(f.field)!;
          expect([f.field, paramsValid(d.params, f.params)]).toEqual([f.field, true]);
        }
      }
    }
  });
});

describe('applying a preset', () => {
  it('omits the fields whose extension is not installed; rows re-fit', () => {
    const survey = applyPreset(presetById('survey')!, NONE);
    expect(fields(survey)).toEqual([
      ['coords', 'accuracy'],
      ['declination'],
      ['targetName', 'targetDistance', 'targetBearing'],
    ]);
    const paddling = applyPreset(presetById('paddling')!, new Set(['gnss']));
    expect(fields(paddling)).toEqual([
      ['speed', 'heading', 'targetName', 'targetDistance'],
      ['eta'],
    ]);
    expect(missingExtensions(presetById('paddling')!.strip, NONE)).toEqual(['tides']);
    expect(missingExtensions(presetById('survey')!.strip, NONE)).toEqual(['gnss']);
    expect(missingExtensions(presetById('survey')!.strip, EVERY)).toEqual([]);
  });

  it('keeps everything with the extensions installed', () => {
    expect(fields(applyPreset(presetById('paddling')!, EVERY))).toEqual(
      fields(presetById('paddling')!.strip),
    );
  });

  it('drops a row left empty', () => {
    const p = {
      ...presetById('paddling')!,
      strip: { ...presetById('paddling')!.strip, rows: [[ref('tides:level')], [ref('eta')]] },
    };
    expect(fields(applyPreset(p, NONE))).toEqual([['eta']]);
  });

  it('returns a copy: editing it never touches the preset', () => {
    const s = applyPreset(presetById('navigation')!, EVERY);
    (s.rows[0]![0]!.params as Record<string, unknown>).target = { kind: 'nextOnTrail' };
    s.rows.pop();
    expect(presetById('navigation')!.strip.rows).toHaveLength(3);
    expect(presetById('navigation')!.strip.rows[0]![0]!.params.target).toBeNull();
  });
});

describe('"· edited"', () => {
  it('a freshly applied preset is not edited; a change makes it so', () => {
    const s = applyPreset(presetById('navigation')!, EVERY);
    expect(isEditedPreset(s, EVERY)).toBe(false);
    expect(isEditedPreset({ ...s, dock: 'top' }, EVERY)).toBe(true);
    expect(isEditedPreset({ ...s, rows: s.rows.slice(0, 2) }, EVERY)).toBe(true);
  });

  it('key order is not an edit; missing extension fields are not either', () => {
    const s = applyPreset(presetById('survey')!, NONE);
    const reordered = {
      ...s,
      rows: s.rows.map((r) =>
        r.map((f) => ({
          field: f.field,
          params: Object.fromEntries(Object.entries(f.params).reverse()),
        })),
      ),
    };
    expect(isEditedPreset(reordered, NONE)).toBe(false);
  });

  it("the user's own strips are never edited", () => {
    const own: InfoStrip = { ...DEFAULT_STRIP, name: 'Ridge survey' };
    delete own.basedOn;
    expect(isEditedPreset(own, EVERY)).toBe(false);
    expect(isEditedPreset({ ...DEFAULT_STRIP, basedOn: 'gone' }, EVERY)).toBe(false);
  });
});

describe('presetAidsSummary (QA 2.6.1: the card read metres in mi/ft)', () => {
  const survey = () => presetById('survey')!;
  it('metric reads as before', () => {
    expect(presetAidsSummary(survey(), METRIC)).toBe(
      'Crosshair · pointing line 500 m, ticks 100 m',
    );
    expect(presetAidsSummary(presetById('hiking')!, METRIC)).toBe('Dot cursor');
  });

  it('mi/ft and nautical read the pointing line as the Pointing line panel does', () => {
    const line = survey().strip.aids.pointingLine!;
    for (const units of [IMPERIAL, NAUTICAL]) {
      const text = presetAidsSummary(survey(), units);
      expect(text).toBe(
        `Crosshair · pointing line ${pointingLineLengthText(line.length, units).toLowerCase()}, ticks ${pointingLineTicksLabel(line.ticks, units).toLowerCase()}`,
      );
    }
    expect(presetAidsSummary(survey(), IMPERIAL)).not.toMatch(/\d m\b/);
    expect(presetAidsSummary(survey(), IMPERIAL)).toMatch(/ft$/);
  });

  it('a switched-off line reads as the cursor alone; no ticks says so', () => {
    const s = survey();
    const line = s.strip.aids.pointingLine!;
    const withLine = (pointingLine: typeof line) => ({
      ...s,
      strip: { ...s.strip, aids: { ...s.strip.aids, pointingLine } },
    });
    expect(presetAidsSummary(withLine({ ...line, enabled: false }), METRIC)).toBe('Crosshair');
    expect(presetAidsSummary(withLine({ ...line, ticks: 'off' }), METRIC)).toBe(
      'Crosshair · pointing line 500 m, no ticks',
    );
  });
});
