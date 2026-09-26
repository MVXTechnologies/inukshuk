import { scrubReport, scrubText } from './scrub';
import type { ErrorReport } from './types';

const CONTAINER = '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';

describe('scrubText — paths and URIs', () => {
  it('replaces a file:// URI with <path>, keeping only the extension', () => {
    const out = scrubText(
      `File file:///var/mobile/Containers/Data/Application/${CONTAINER}/Documents/maps/Lac%20Blanc.pdf is locked`,
    );
    expect(out).toBe('File file:///<path>.pdf is locked');
  });

  it('replaces an absolute path, even one whose file name has spaces', () => {
    expect(scrubText('ENOENT: open /data/user/0/com.inukshuk.app/files/tracks/My Hike.gpx')).toBe(
      'ENOENT: open <path>.gpx',
    );
    expect(scrubText('open /storage/emulated/0/Download/topo.pdf failed')).toBe(
      'open <path>.pdf failed',
    );
  });

  // The frames must stay readable: function name, line and column survive.
  it('keeps stack frames useful while dropping the bundle path and container id', () => {
    const stack = [
      'Error: boom',
      `    at renderCrop (address at /private/var/containers/Bundle/Application/${CONTAINER}/Inukshuk.app/main.jsbundle:1:234567)`,
      '    at parseGeoPdf@https://u.expo.dev/ba200eac/bundles/android-123.js:12:34',
    ].join('\n');
    expect(scrubText(stack)).toBe(
      [
        'Error: boom',
        '    at renderCrop (address at <path>.jsbundle:1:234567)',
        '    at parseGeoPdf@https://u.expo.dev/<path>.js:12:34',
      ].join('\n'),
    );
  });

  it('keeps the host of a web URL but not its path or query', () => {
    expect(
      scrubText('fetch https://tile.openstreetmap.org/15/9634/11700.png?lat=46.8 failed'),
    ).toBe('fetch https://tile.openstreetmap.org/<path>.png failed');
    expect(scrubText('GET https://api.github.com returned 503')).toBe(
      'GET https://api.github.com returned 503',
    );
  });

  it('strips content:// documents and app-scheme redirects (an OAuth code is a secret)', () => {
    expect(
      scrubText('content://com.android.providers.downloads.documents/document/My%20hike.gpx'),
    ).toBe('content://com.android.providers.downloads.documents/<path>.gpx');
    expect(scrubText('inukshuk://localhost/strava-auth?code=abc123&state=n0nce')).toBe(
      'inukshuk://localhost/<path>',
    );
  });

  it('replaces any remaining UUID', () => {
    expect(scrubText(`container ${CONTAINER} rotated`)).toBe('container <uuid> rotated');
  });

  it('leaves slashes that are not paths alone', () => {
    const text = 'rendered 1/2 pages at 60 km/h and/or in 45000ms';
    expect(scrubText(text)).toBe(text);
  });
});

describe('scrubText — quoted user strings', () => {
  it('scrubs double, typographic and backtick quotes', () => {
    expect(scrubText('re-parse of "Lac Blanc 1:50k" failed')).toBe('re-parse of <str> failed');
    expect(scrubText('The file “Mont Tremblant.pdf” couldn’t be opened')).toBe(
      'The file <str> couldn’t be opened',
    );
    expect(scrubText('Paused page 2 of «Carte» and `Sentier`')).toBe(
      'Paused page 2 of <str> and <str>',
    );
  });

  it('keeps engine property names in single quotes — they make a crash fixable', () => {
    const text = "TypeError: Cannot read property 'renderedPageBox' of undefined";
    expect(scrubText(text)).toBe(text);
    expect(scrubText("Property 'geo.pageIndex' doesn't exist")).toBe(
      "Property 'geo.pageIndex' doesn't exist",
    );
  });

  it('scrubs single-quoted text that is not an identifier', () => {
    expect(scrubText("Could not import 'Sortie au lac' (bad XML)")).toBe(
      'Could not import <str> (bad XML)',
    );
  });

  it('never pairs apostrophes into a quoted string', () => {
    const text = "Couldn't open the file — it's locked, isn't it";
    expect(scrubText(text)).toBe(text);
  });

  it('keeps JSON keys and scrubs their string values', () => {
    expect(scrubText('made-map-import {"name":"Sortie au lac","format":"A4","grid":true}')).toBe(
      'made-map-import {"name":<str>,"format":<str>,"grid":true}',
    );
  });
});

describe('scrubText — coordinates', () => {
  it('scrubs a precise lon/lat pair in any common shape', () => {
    expect(scrubText('pin w1 at [-71.208231, 46.813422]')).toBe('pin w1 at [<coord>]');
    expect(scrubText('46.8134,-71.2082 is off the sheet')).toBe('<coord> is off the sheet');
    expect(scrubText('corners [500000.12345,5200000.54321] in UTM')).toBe(
      'corners [<coord>] in UTM',
    );
  });

  it('scrubs a labelled latitude or longitude at any precision', () => {
    expect(scrubText('{"lat":46.8,"lon":-71.2} latitude=46 longitude: -71.21')).toBe(
      '{"lat":<coord>,"lon":<coord>} latitude=<coord> longitude: <coord>',
    );
  });

  it('leaves numbers that do not look like a place alone', () => {
    const text = 'version 1.5.3, scale 3.14159, 2 pages, 45000ms, page 1 of 12.5000';
    expect(scrubText(text)).toBe(text);
  });
});

describe('scrubText — as a whole', () => {
  // What the app actually composed before this change (useReparseStoredMaps,
  // MapScreen's map-tap, makeMap's context): each leaked user content.
  it.each([
    ['re-parse of "Lac Blanc" found no georeferencing; keeping the stored one', /Lac Blanc/],
    [
      'skipping 1 waypoint(s) with an unmappable position, e.g. w1 at [-71.2082317, 46.8134221]',
      /46\.8/,
    ],
    ['made-map-import {"name":"Chalet de Marc","format":"letter"}', /Chalet/],
  ])('removes the user content from %p', (text, leak) => {
    expect(scrubText(text)).not.toMatch(leak);
  });

  it('is idempotent', () => {
    const text = `open file:///x/${CONTAINER}/My map.pdf "Lac" at 46.81234, -71.20823 'Sortie au lac'`;
    const once = scrubText(text);
    expect(scrubText(once)).toBe(once);
  });
});

describe('scrubReport', () => {
  const report: ErrorReport = {
    fingerprint: 'aabbccdd',
    message: 'Error: could not open "Lac Blanc"',
    stack: `Error\n    at open (address at /var/containers/${CONTAINER}/main.jsbundle:1:2)`,
    componentStack: '\n    in MapScreen (at /Users/marc/app/MapScreen.tsx:10)',
    isFatal: false,
    context: 'made-map-import {"name":"Chalet"}',
    breadcrumbs: ['2026-09-25T12:00:00.000Z open-with intent received for /sdcard/Hike.gpx'],
    firstSeenAt: 1,
    lastSeenAt: 2,
    count: 3,
    environment: { appVersion: '1.6.0', runtimeVersion: 'ff1e4f0f', os: 'ios 26', model: 'iPhone' },
  };

  it('scrubs every free-text field', () => {
    const out = scrubReport(report);
    expect(out.message).toBe('Error: could not open <str>');
    expect(out.stack).toBe('Error\n    at open (address at <path>.jsbundle:1:2)');
    expect(out.componentStack).toBe('\n    in MapScreen (at <path>.tsx:10)');
    expect(out.context).toBe('made-map-import {"name":<str>}');
    expect(out.breadcrumbs).toEqual([
      '2026-09-25T12:00:00.000Z open-with intent received for <path>.gpx',
    ]);
  });

  it('leaves the dedupe key, counts and environment exactly as they were', () => {
    const out = scrubReport(report);
    expect(out.fingerprint).toBe(report.fingerprint);
    expect(out.environment).toEqual(report.environment);
    expect([out.count, out.firstSeenAt, out.lastSeenAt, out.isFatal]).toEqual([3, 1, 2, false]);
    expect(report.message).toBe('Error: could not open "Lac Blanc"'); // not mutated
  });

  it('adds no optional fields the report did not have', () => {
    const bare: ErrorReport = { ...report };
    delete bare.stack;
    delete bare.componentStack;
    delete bare.context;
    expect(Object.keys(scrubReport(bare)).sort()).toEqual(Object.keys(bare).sort());
  });
});
