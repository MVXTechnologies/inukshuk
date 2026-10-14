import { computeRows, sameValue, spokenValue } from './compute';
import { ref } from './presets';
import { fix, METRIC, QC, snapshot } from './testUtils';

describe('computeRows', () => {
  it('computes each placed field; missing data steps aside, an empty row goes', () => {
    const rows = [
      [ref('coords'), ref('elevation')],
      [ref('targetName'), ref('targetDistance')],
      [{ field: 'weather:wind', params: {} }, ref('speed')],
    ];
    const out = computeRows(rows, snapshot({ centre: QC }), METRIC);
    // No DEM tile, no target, no fix: only the coordinates are left.
    expect(out).toHaveLength(1);
    expect(out[0]!.map((p) => p.ref.field)).toEqual(['coords']);
    expect(out[0]![0]).toEqual(
      expect.objectContaining({ row: 0, index: 0, value: expect.objectContaining({}) }),
    );

    const live = computeRows(rows, snapshot({ centre: QC, position: fix() }), METRIC);
    expect(live.map((r) => r.map((p) => `${p.row}:${p.index}:${p.ref.field}`))).toEqual([
      ['0:0:coords'],
      ['2:1:speed'],
    ]);
  });
});

describe('sameValue / spokenValue', () => {
  it('compares what is drawn', () => {
    const a = { glyph: 'speed', value: '3.6', unit: 'km/h' };
    expect(sameValue(a, { ...a })).toBe(true);
    expect(sameValue(a, { ...a, value: '3.7' })).toBe(false);
    expect(sameValue(a, { ...a, unit: 'mph' })).toBe(false);
    expect(sameValue(a, { ...a, glyph: 'sailing' })).toBe(false);
    expect(sameValue(a, { ...a, tag: 'SOG' })).toBe(false);
    expect(sameValue(a, { ...a, tone: 'ok' })).toBe(false);
  });

  it('compares what the value is to: its name, its look, whether it names it', () => {
    const s = { key: 'waypoint:w1', name: 'Camp lac', glyph: 'place', pin: { color: '#E8612C' } };
    const a = { value: '1.2', unit: 'km', subject: s };
    expect(sameValue(a, { ...a, subject: { ...s, pin: { ...s.pin } } })).toBe(true);
    expect(sameValue(a, { value: '1.2', unit: 'km' })).toBe(false);
    expect(sameValue(a, { ...a, subject: { ...s, name: 'Camp' } })).toBe(false);
    expect(sameValue(a, { ...a, subject: { ...s, key: 'destination' } })).toBe(false);
    expect(sameValue(a, { ...a, subject: { ...s, pin: { color: '#1E64C8' } } })).toBe(false);
    expect(sameValue(a, { ...a, subject: { ...s, pin: { color: '#E8612C', icon: 'camp' } } })).toBe(
      false,
    );
    expect(sameValue(a, { ...a, subject: { key: s.key, name: s.name, glyph: s.glyph } })).toBe(
      false,
    );
    expect(sameValue(a, { ...a, namesSubject: true })).toBe(false);
  });

  it('reads label, tag, value and unit', () => {
    expect(spokenValue('Speed', { value: '3.6', unit: 'km/h' })).toBe('Speed 3.6 km/h');
    expect(spokenValue('Time to target (ETE)', { tag: 'ETE', value: '0:21', unit: '' })).toBe(
      'Time to target (ETE) ETE 0:21',
    );
  });
});
