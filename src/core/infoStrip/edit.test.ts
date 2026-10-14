import { DEFAULT_STRIP, presetById, ref } from './presets';
import {
  addField,
  canAddRow,
  datumTag,
  dropSlot,
  moveField,
  moveRow,
  removeField,
  setFieldParams,
  stripTitle,
  uniqueName,
  type RowRect,
} from './edit';
import type { FieldRef } from './types';

const unknown: FieldRef = { field: 'weather:wind', params: {} };
const ids = (rows: readonly (readonly FieldRef[])[] | null) =>
  rows === null ? null : rows.map((r) => r.map((f) => f.field));

describe('addField', () => {
  const rows = [[ref('coords'), ref('elevation')]];

  it('adds at the end of a row while it fits', () => {
    expect(ids(addField(rows, 0, ref('speed')))).toEqual([['coords', 'elevation', 'speed']]);
    // 3 of 4 spaces used: a 2-space field does not fit.
    expect(addField(rows, 0, ref('coords'))).toBeNull();
    expect(addField(rows, 5, ref('speed'))).toBeNull();
    // An unknown field (a newer build's) takes no space.
    expect(ids(addField(rows, 0, unknown))).toEqual([['coords', 'elevation', 'weather:wind']]);
  });

  it('starts a new row, up to three', () => {
    expect(ids(addField(rows, 1, ref('coords')))).toEqual([['coords', 'elevation'], ['coords']]);
    const three = [[ref('speed')], [ref('speed')], [ref('speed')]];
    expect(canAddRow(three)).toBe(false);
    expect(addField(three, 3, ref('speed'))).toBeNull();
  });

  it('never mutates its input', () => {
    addField(rows, 0, ref('speed'));
    expect(rows[0]).toHaveLength(2);
  });
});

describe('removeField / setFieldParams', () => {
  it('removes; an emptied row goes', () => {
    const rows = [[ref('speed')], [ref('coords'), ref('heading')]];
    expect(ids(removeField(rows, { row: 1, index: 0 }))).toEqual([['speed'], ['heading']]);
    expect(ids(removeField(rows, { row: 0, index: 0 }))).toEqual([['coords', 'heading']]);
  });

  it("replaces one field's params", () => {
    const rows = [[ref('speed'), ref('heading')], [ref('sunset')]];
    const out = setFieldParams(rows, { row: 0, index: 1 }, { source: 'course', reference: 'true' });
    expect(out[0]![1]!.params).toEqual({ source: 'course', reference: 'true' });
    expect(out[0]![0]).toBe(rows[0]![0]);
    expect(out[1]).toEqual(rows[1]);
    expect(rows[0]![1]!.params).toEqual({ source: 'compass', reference: 'true' });
  });
});

describe('moveField', () => {
  const rows = [
    [ref('targetName'), ref('targetDistance'), ref('ete')],
    [ref('coords'), ref('elevation')],
  ];

  it('reorders within a row (to is an index in the row as it is)', () => {
    expect(ids(moveField(rows, { row: 0, index: 0 }, { row: 0, index: 3 }))).toEqual([
      ['targetDistance', 'ete', 'targetName'],
      ['coords', 'elevation'],
    ]);
    expect(ids(moveField(rows, { row: 0, index: 2 }, { row: 0, index: 0 }))).toEqual([
      ['ete', 'targetName', 'targetDistance'],
      ['coords', 'elevation'],
    ]);
    // On itself, or just after itself: nothing moves.
    expect(moveField(rows, { row: 0, index: 1 }, { row: 0, index: 1 })).toBeNull();
    expect(moveField(rows, { row: 0, index: 1 }, { row: 0, index: 2 })).toBeNull();
    // Clamped to the row.
    expect(ids(moveField(rows, { row: 0, index: 0 }, { row: 0, index: 99 }))![0]).toEqual([
      'targetDistance',
      'ete',
      'targetName',
    ]);
  });

  it('moves to another row when it fits there; an emptied row goes', () => {
    expect(ids(moveField(rows, { row: 0, index: 2 }, { row: 1, index: 0 }))).toEqual([
      ['targetName', 'targetDistance'],
      ['ete', 'coords', 'elevation'],
    ]);
    expect(ids(moveField(rows, { row: 0, index: 2 }, { row: 1, index: -3 }))![1]![0]).toBe('ete');
    // Coordinates (2 spaces) do not fit beside 3 used spaces.
    expect(moveField(rows, { row: 1, index: 0 }, { row: 0, index: 0 })).toBeNull();
    const single = [[ref('speed')], [ref('heading')]];
    expect(ids(moveField(single, { row: 0, index: 0 }, { row: 1, index: 1 }))).toEqual([
      ['heading', 'speed'],
    ]);
    expect(moveField(single, { row: 0, index: 0 }, { row: 7, index: 0 })).toBeNull();
    expect(moveField(single, { row: 3, index: 0 }, { row: 0, index: 0 })).toBeNull();
  });

  it('makes a new row, unless that changes nothing or the strip is full', () => {
    expect(ids(moveField(rows, { row: 0, index: 0 }, { row: 2, index: 0 }))).toEqual([
      ['targetDistance', 'ete'],
      ['coords', 'elevation'],
      ['targetName'],
    ]);
    expect(moveField([[ref('speed')]], { row: 0, index: 0 }, { row: 1, index: 0 })).toBeNull();
    const full = [[ref('speed'), ref('heading')], [ref('sunset')], [ref('eta')]];
    expect(moveField(full, { row: 0, index: 0 }, { row: 3, index: 0 })).toBeNull();
  });

  it('carries unknown fields along (they take no space)', () => {
    const withUnknown = [
      [unknown, ref('speed')],
      [ref('coords'), ref('elevation'), ref('eta')],
    ];
    expect(ids(moveField(withUnknown, { row: 0, index: 0 }, { row: 1, index: 0 }))).toEqual([
      ['speed'],
      ['weather:wind', 'coords', 'elevation', 'eta'],
    ]);
  });
});

describe('moveRow', () => {
  const rows = [[ref('speed')], [ref('heading')], [ref('sunset')]];
  it('moves a row, clamped; null when it stays', () => {
    expect(ids(moveRow(rows, 0, 2))).toEqual([['heading'], ['sunset'], ['speed']]);
    expect(ids(moveRow(rows, 2, -4))).toEqual([['sunset'], ['speed'], ['heading']]);
    expect(moveRow(rows, 1, 1)).toBeNull();
    expect(moveRow(rows, 5, 0)).toBeNull();
  });
});

describe('dropSlot', () => {
  const field = (x: number) => ({ x, w: 80 });
  const rects: RowRect[] = [
    { y: 100, h: 40, fields: [field(0), field(90), field(180)] },
    { y: 150, h: 40, fields: [field(0)] },
  ];

  it('picks the row under the point and the index by field centres', () => {
    expect(dropSlot(rects, { x: 10, y: 120 })).toEqual({ row: 0, index: 0 });
    expect(dropSlot(rects, { x: 140, y: 120 })).toEqual({ row: 0, index: 2 });
    expect(dropSlot(rects, { x: 300, y: 120 })).toEqual({ row: 0, index: 3 });
    // Above the first row: the first.
    expect(dropSlot(rects, { x: 10, y: 0 })).toEqual({ row: 0, index: 0 });
    expect(dropSlot(rects, { x: 300, y: 160 })).toEqual({ row: 1, index: 1 });
  });

  it('below the last row: a new row while there is room, else the last', () => {
    expect(dropSlot(rects, { x: 10, y: 400 })).toEqual({ row: 2, index: 0 });
    const three = [...rects, { y: 200, h: 40, fields: [field(0)] }];
    expect(dropSlot(three, { x: 10, y: 400 })).toEqual({ row: 2, index: 0 });
    expect(dropSlot([], { x: 0, y: 0 })).toBeNull();
  });
});

describe('names and labels', () => {
  it('uniqueName numbers a taken name, case-insensitively, within the limit', () => {
    expect(uniqueName('Ridge survey', [])).toBe('Ridge survey');
    expect(uniqueName('Ridge survey', ['ridge SURVEY'])).toBe('Ridge survey 2');
    expect(uniqueName('Ridge survey', ['Ridge survey', 'Ridge survey 2'])).toBe('Ridge survey 3');
    expect(uniqueName('   ', [])).toBe('My strip');
    const long = 'x'.repeat(40);
    expect(uniqueName(long, [long])).toBe(`${'x'.repeat(38)} 2`);
    expect(uniqueName('abc', ['abc'], 3)).toBe('a 2');
  });

  it('stripTitle marks an edited preset', () => {
    expect(stripTitle(DEFAULT_STRIP, false)).toBe('Default');
    expect(stripTitle(presetById('navigation')!.strip, true)).toBe('Navigation · edited');
  });

  it('datumTag shortens the Convert output label', () => {
    expect(datumTag('NAD83(CSRS) 2010.0')).toBe('CSRS');
    expect(datumTag('NAD83 (original)')).toBe('NAD83');
    expect(datumTag('ITRF2020 @ 2026.76')).toBe('ITRF2020');
    expect(datumTag('WGS 84')).toBe('WGS 84');
    expect(datumTag('ITRF2014 2010.0')).toBe('ITRF2014');
    expect(datumTag('  ')).toBe('');
  });
});
