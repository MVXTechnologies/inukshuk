import { asciiToBytes } from './bytes';
import { FixAssembler } from './fix';
import { nmeaEpoch, quebecRtkSession } from './sim';
import { GnssDemuxer } from './stream';

function parse(text: string) {
  const d = new GnssDemuxer();
  const a = new FixAssembler();
  const fixes = d.push(asciiToBytes(text)).flatMap((ev) => a.push(ev, 0));
  return [...fixes, ...a.flush(0)];
}

describe('synthetic streams', () => {
  it('every sentence of the Québec session passes its checksum', () => {
    const { text, epochs } = quebecRtkSession();
    const d = new GnssDemuxer();
    const events = d.push(asciiToBytes(text));
    expect(events).toHaveLength(epochs.length * 3);
    expect(d.stats.garbageBytes).toBe(0);
  });

  it('writes each GGA quality with the matching RMC mode, date and age', () => {
    const base = { tod: 43_200, lat: 46.8, lon: -71.2, sigma: 0.5, ageS: null };
    const kinds = [0, 1, 2, 4, 5].map(
      (quality) => parse(nmeaEpoch({ ...base, quality, date: '071026' }))[0]?.kind,
    );
    expect(kinds).toEqual(['none', 'autonomous', 'dgps', 'rtk-fixed', 'rtk-float']);
    const [f] = parse(nmeaEpoch({ ...base, quality: 4, ageS: 2.5, lat: -33.9, lon: 151.2 }));
    expect(f?.correctionAgeS).toBe(2.5);
    expect(f?.lat).toBeCloseTo(-33.9, 7);
    expect(f?.lon).toBeCloseTo(151.2, 7);
    expect(f?.timeMs).toBe(Date.UTC(2026, 9, 1, 12));
  });
});
