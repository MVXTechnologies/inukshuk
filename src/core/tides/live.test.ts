import {
  coopsHiLoUrl,
  coopsLevelUrl,
  kvExtremes,
  kvUrl,
  liveTide,
  nowLine,
  parseCoopsHiLo,
  parseCoopsLevels,
  parseKartverket,
} from './live';

// Real responses, trimmed (fetched 2026-10-05).
const COOPS_LEVELS = {
  metadata: { id: '8518750', name: 'The Battery', lat: '40.7006', lon: '-74.0142' },
  data: [
    { t: '2026-10-05 12:54', v: '0.593', s: '0.094', f: '1,0,0,0', q: 'p' },
    { t: '2026-10-05 13:00', v: '0.563', s: '0.079', f: '1,0,0,0', q: 'p' },
    { t: '2026-10-05 13:06', v: '0.567', s: '0.066', f: '1,0,0,0', q: 'p' },
    { t: '2026-10-05 12:48', v: '0.621', s: '0.083', f: '1,0,0,0', q: 'p' },
    { t: 'junk', v: '1' },
  ],
};
const COOPS_HILO = {
  predictions: [
    { t: '2026-10-05 14:31', v: '0.255', type: 'L' },
    { t: '2026-10-05 20:34', v: '1.57', type: 'H' },
    { t: '2026-10-06 03:22', v: '0.119', type: 'L' },
  ],
};
const KV_OBS = `<tide><locationdata><data type="observation" unit="cm">
<waterlevel value="111.4" time="2026-10-05T12:40:00+00:00" flag="obs"/>
<waterlevel value="113.1" time="2026-10-05T12:50:00+00:00" flag="obs"/>
<waterlevel value="115.2" time="2026-10-05T13:00:00+00:00" flag="obs"/>
</data></locationdata></tide>`;
const KV_TAB = `<tide><locationdata><data type="prediction" unit="cm">
<waterlevel value="135.2" time="2026-10-05T17:18:00+00:00" flag="high"/>
<waterlevel value="61.2" time="2026-10-06T00:08:00+00:00" flag="low"/>
</data></locationdata></tide>`;

const NOW = Date.parse('2026-10-05T13:10:00Z');

describe('live tide parsers', () => {
  it('CO-OPS water level (GMT, metres above MLLW), sorted, junk skipped', () => {
    const r = parseCoopsLevels(COOPS_LEVELS);
    expect(r).toHaveLength(4);
    expect(r[r.length - 1]).toEqual({ timeMs: Date.parse('2026-10-05T13:06:00Z'), heightM: 0.567 });
    expect(parseCoopsLevels({ error: { message: 'No data' } })).toEqual([]);
    expect(parseCoopsLevels('nope')).toEqual([]);
  });

  it('CO-OPS high/low predictions keep the API labels', () => {
    const e = parseCoopsHiLo(COOPS_HILO);
    expect(e.map((x) => x.kind)).toEqual(['low', 'high', 'low']);
    expect(e[1]?.heightM).toBe(1.57);
  });

  it('Kartverket XML in cm → metres', () => {
    const obs = parseKartverket(KV_OBS);
    expect(obs[2]?.reading.heightM).toBeCloseTo(1.152, 6);
    expect(obs.every((o) => o.flag === 'obs')).toBe(true);
    const ex = kvExtremes(parseKartverket(KV_TAB), NOW);
    expect(ex.map((x) => [x.kind, x.heightM])).toEqual([
      ['high', 1.352],
      ['low', 0.612],
    ]);
    expect(parseKartverket(null)).toEqual([]);
  });

  it('builds the Now line: fresh level, trend, next extreme', () => {
    const live = liveTide(parseCoopsLevels(COOPS_LEVELS), parseCoopsHiLo(COOPS_HILO), NOW);
    expect(live.level?.heightM).toBe(0.567);
    expect(live.trend).toBe('falling');
    expect(nowLine(live, 'MLLW', () => '14:31')).toBe(
      'Water 0.57 m above MLLW · falling · next low 14:31 (0.26 m)',
    );
  });

  it('never calls a stale reading "now"', () => {
    const live = liveTide(parseCoopsLevels(COOPS_LEVELS), [], NOW + 3 * 3_600_000);
    expect(live.level).toBeNull();
    expect(nowLine(live, 'MLLW', () => '')).toBeNull();
  });

  it('builds key-free request URLs', () => {
    expect(coopsLevelUrl('8518750', NOW)).toBe(
      'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_level&begin_date=20261005%2012%3A10&range=1&station=8518750&datum=MLLW&units=metric&time_zone=gmt&format=json&application=Inukshuk',
    );
    expect(coopsHiLoUrl('8518750', NOW)).toContain(
      'interval=hilo&begin_date=20261005%2013%3A10&range=36',
    );
    expect(kvUrl(60.398046, 5.320487, 'tab', NOW, NOW + 3_600_000)).toBe(
      'https://vannstand.kartverket.no/tideapi.php?tide_request=locationdata&lat=60.398046&lon=5.320487&datatype=tab&refcode=cd&lang=en&fromtime=2026-10-05T13:10:00Z&totime=2026-10-05T14:10:00Z&interval=10&dst=0&tzone=0',
    );
  });
});
