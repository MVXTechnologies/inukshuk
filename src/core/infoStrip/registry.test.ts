import { ALL_EXTENSION_KEYS, type AnyExtensionKey } from '@core/extensions/keys';
import { HERO_FIELD_ORDER } from '@core/recording/panel';

import { paramsValid } from './params';
import {
  FIELD_GROUPS,
  FIELD_IDS,
  FIELDS,
  fieldAvailable,
  fieldDescriptor,
  isFieldId,
  pickableFields,
} from './registry';
import { METRIC, snapshot } from './testUtils';
import { TICK_ORDER, type FieldDescriptor } from './types';

const ALL = FIELD_IDS.map((id) => FIELDS[id] as FieldDescriptor);
const NONE = new Set<AnyExtensionKey>();
const EVERY = new Set<AnyExtensionKey>(ALL_EXTENSION_KEYS);

describe('the field registry', () => {
  it('keys every descriptor by its own id; ids are unique', () => {
    for (const id of FIELD_IDS) expect(FIELDS[id].id).toBe(id);
    expect(new Set(ALL.map((d) => d.id)).size).toBe(ALL.length);
  });

  it('names never collide, and every field has a summary', () => {
    expect(new Set(ALL.map((d) => d.label)).size).toBe(ALL.length);
    for (const d of ALL) {
      expect(d.label.trim()).toBe(d.label);
      expect(d.summary.length).toBeGreaterThan(0);
      expect(d.summary.endsWith('.')).toBe(false);
    }
  });

  it('every field takes 1 or 2 of the 4 spaces; only coordinates take 2', () => {
    for (const d of ALL) expect([1, 2]).toContain(d.spaces);
    expect(ALL.filter((d) => d.spaces === 2).map((d) => d.id)).toEqual(['coords']);
  });

  it("every field's defaults pass its own schema", () => {
    for (const d of ALL) {
      expect([d.id, paramsValid(d.params, d.defaults)]).toEqual([d.id, true]);
      expect(Object.keys(d.defaults).sort()).toEqual(Object.keys(d.params).sort());
    }
  });

  it('every choice param lists unique values with labels', () => {
    for (const d of ALL) {
      for (const spec of Object.values(d.params)) {
        expect(spec.label.length).toBeGreaterThan(0);
        if (spec.kind !== 'choice') continue;
        const values = spec.options.map((o) => o.value);
        expect(new Set(values).size).toBe(values.length);
        for (const o of spec.options) expect(o.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('groups, ticks and extension requirements are known values', () => {
    for (const d of ALL) {
      expect(FIELD_GROUPS).toContain(d.group);
      expect(TICK_ORDER).toContain(d.tick);
      if (d.requires !== undefined) {
        expect(ALL_EXTENSION_KEYS).toContain(d.requires);
        expect(d.group).toBe('extension');
        expect(d.id.startsWith(`${d.requires}:`)).toBe(true);
        expect(d.deps).toContain(`ext:${d.requires}`);
      }
    }
  });

  it('recording metrics are hero fields, each owned by one field', () => {
    const metrics = ALL.flatMap((d) => (d.recordingMetric ? [d.recordingMetric] : []));
    for (const m of metrics) expect(HERO_FIELD_ORDER).toContain(m);
    expect(new Set(metrics).size).toBe(metrics.length);
    // Every hero metric has a strip field.
    expect([...metrics].sort()).toEqual([...HERO_FIELD_ORDER].sort());
  });

  it('with no data, every field leaves itself out or says "—" (never invents a value)', () => {
    for (const d of ALL) {
      const v = d.compute(snapshot(), d.defaults, METRIC);
      if (v !== null) expect(v.value).toBe('—');
    }
  });

  it('every sample is a drawable value', () => {
    for (const d of ALL) expect(d.sample.value.length).toBeGreaterThan(0);
  });

  it('looks fields up by id; unknown ids are undefined', () => {
    expect(fieldDescriptor('coords')).toBe(FIELDS.coords);
    expect(fieldDescriptor('weather:wind')).toBeUndefined();
    expect(fieldDescriptor('toString')).toBeUndefined();
    expect(isFieldId('eta')).toBe(true);
    expect(isFieldId(42)).toBe(false);
  });
});

describe('the picker list', () => {
  it('lists only what fits the free spaces (nothing greyed out)', () => {
    const one = pickableFields(1, EVERY).map((d) => d.id);
    expect(one).not.toContain('coords');
    expect(pickableFields(2, EVERY).map((d) => d.id)).toContain('coords');
    expect(pickableFields(0, EVERY)).toEqual([]);
  });

  it("lists an extension's fields only once it is installed", () => {
    const ids = pickableFields(4, NONE).map((d) => d.id);
    expect(ids).not.toContain('tides:level');
    expect(ids).not.toContain('gnss:fix');
    expect(pickableFields(4, new Set(['tides'])).map((d) => d.id)).toContain('tides:level');
    expect(fieldAvailable(FIELDS['gnss:fix'], new Set(['gnss']))).toBe(true);
  });

  it('searches names, summaries and synonyms, ignoring case and accents', () => {
    expect(pickableFields(4, NONE, 'dist').map((d) => d.id)).toEqual(
      expect.arrayContaining(['targetDistance', 'offTrail', 'hero:distance']),
    );
    expect(pickableFields(4, NONE, '  RANGE ').map((d) => d.id)).toEqual([
      'targetDistance',
      'cursorDistance',
    ]);
    // The cursor fields sit with the target fields (owner: "Bearing/Distance to cursor").
    expect(pickableFields(4, NONE, 'cursor').map((d) => d.id)).toEqual([
      'cursorBearing',
      'cursorDistance',
    ]);
    expect(pickableFields(4, NONE, 'déclinaison').length).toBe(0);
    expect(pickableFields(4, NONE, 'DÉCLINATION').map((d) => d.id)).toEqual(['declination']);
  });
});
