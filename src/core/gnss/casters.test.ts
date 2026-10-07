import { CASTER_PRESETS, datumHint, frameComplete, frameLabel, presetById } from './casters';
import { decodeDatumTransform, type Rtcm3Frame } from './rtcm3';
import { GnssDemuxer, type StreamEvent } from './stream';
import { loadCapture } from './testUtils';

describe('correction profiles', () => {
  it('presets: frame known only where the service documents it; no MRNF preset yet (P2)', () => {
    expect(CASTER_PRESETS.map((p) => p.id)).toEqual(['rtk2go', 'emlid', 'polaris']);
    expect(presetById('rtk2go')?.frame).toBeNull();
    expect(presetById('polaris')?.frame).toEqual({ frame: 'itrf2014', epoch: 'observation' });
    expect(presetById('mrnf')).toBeUndefined();
    for (const p of CASTER_PRESETS) expect(p.source).toMatch(/^https?:\/\//);
  });

  it('labels frames with their epoch', () => {
    expect(frameLabel({ frame: 'csrs', epoch: 1997 })).toBe('NAD83(CSRS) 1997.0');
    expect(frameLabel({ frame: 'itrf2014', epoch: 'observation' })).toBe(
      'ITRF2014 (current epoch)',
    );
    expect(frameLabel({ frame: 'csrs' })).toBe('NAD83(CSRS) (epoch?)');
    expect(frameLabel({ frame: 'wgs84' })).toBe('WGS 84');
    expect(frameLabel({ frame: 'nad83-2011', epoch: 2000 })).toBe('NAD83(2011)');
    expect(frameComplete({ frame: 'csrs' })).toBe(false);
    expect(frameComplete({ frame: 'csrs', epoch: 2010 })).toBe(true);
    expect(frameComplete({ frame: 'nad83-2011' })).toBe(true);
  });

  it('an RTCM 1021 becomes an information-only hint', () => {
    const f = new GnssDemuxer()
      .push(loadCapture('gpsd/rtcm3_102x135.log'))
      .find(
        (e): e is Extract<StreamEvent, { kind: 'rtcm3' }> =>
          e.kind === 'rtcm3' && e.frame.type === 1021,
      ) as { frame: Rtcm3Frame };
    const t = decodeDatumTransform(f.frame.payload);
    if (!t) throw new Error();
    expect(datumHint(t)).toEqual({
      sourceName: '5001',
      targetName: '4001',
      systemId: 9,
      text: 'The network announces 5001 → 4001 (RTCM 1021); shown for information, not applied.',
    });
    expect(datumHint({ ...t, sourceName: ' ', targetName: '' }).text).toContain('? → ?');
  });
});
