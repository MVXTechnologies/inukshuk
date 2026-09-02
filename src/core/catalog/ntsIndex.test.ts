import { parseNtsIndexKml } from './ntsIndex';

/** A placemark shaped like the ones in NRCan's nts_snrc.kmz. */
function placemark(name: string, snippet: string, ring: string, point = '-71.75,46.875,0'): string {
  return [
    `<Placemark id="kml_1">`,
    `<name>${name}</name>`,
    `<visibility>1</visibility>`,
    `<snippet>${snippet}</snippet>`,
    `<description><![CDATA[${name}<br>${snippet}]]></description>`,
    `<MultiGeometry>`,
    `<Polygon><outerBoundaryIs><LinearRing>`,
    `<coordinates>${ring}</coordinates>`,
    `</LinearRing></outerBoundaryIs></Polygon>`,
    `<Point><coordinates>${point} </coordinates></Point>`,
    `</MultiGeometry>`,
    `</Placemark>`,
  ].join('\n');
}

/** Québec City's sheet, densified the way the real index densifies its edges. */
const QUEBEC_RING = [
  '-71.5,46.75,0',
  '-71.5,46.8666666667,0',
  '-71.5,47,0',
  '-71.25,47,0',
  '-71,47,0',
  '-71,46.75,0',
  '-71.5,46.75,0',
].join(' ');

describe('parseNtsIndexKml', () => {
  it('reads the sheet id, toponym and polygon extent', () => {
    const sheets = parseNtsIndexKml(placemark('021L14', 'QUÉBEC', QUEBEC_RING));
    expect(sheets.get('021L14')).toEqual({
      toponym: 'QUÉBEC',
      bbox: [-71.5, 46.75, -71, 47],
    });
  });

  it('places a sheet the computed NTS grid cannot model (above 60°N)', () => {
    // 340E05, Ellesmere Island, as the real index draws it: 1:50k sheets are
    // 2° wide that far north, and ntsSheetBbox returns null for quad 340.
    const ring = '-80,82.25,0 -80,82.5,0 -78,82.5,0 -78,82.25,0 -80,82.25,0';
    const sheets = parseNtsIndexKml(placemark('340E05', '', ring));
    expect(sheets.get('340E05')?.bbox).toEqual([-80, 82.25, -78, 82.5]);
  });

  it('ignores the label Point when computing the extent', () => {
    // A point outside the ring would widen a naive bbox; only rings count.
    const sheets = parseNtsIndexKml(placemark('021L14', 'QUÉBEC', QUEBEC_RING, '-80,20,0'));
    expect(sheets.get('021L14')?.bbox).toEqual([-71.5, 46.75, -71, 47]);
  });

  it('keeps 1:50k sheets and skips 1:250k tiles', () => {
    const kml = [
      placemark('021L', 'QUÉBEC', QUEBEC_RING),
      placemark('021L14', 'QUÉBEC', QUEBEC_RING),
    ].join('\n');
    const sheets = parseNtsIndexKml(kml);
    expect([...sheets.keys()]).toEqual(['021L14']);
  });

  it('uppercases ids and keeps the first placemark for a sheet', () => {
    const kml = [
      placemark('021l14', 'QUÉBEC', QUEBEC_RING),
      placemark('021L14', 'DUPLICATE', '-1,-1,0 -1,1,0 1,1,0 1,-1,0 -1,-1,0'),
    ].join('\n');
    expect(parseNtsIndexKml(kml).get('021L14')?.toponym).toBe('QUÉBEC');
  });

  it('omits an unusable extent rather than inventing one', () => {
    const degenerate = parseNtsIndexKml(placemark('021L14', 'QUÉBEC', '-71.5,47,0 -71.5,47,0'));
    expect(degenerate.get('021L14')).toEqual({ toponym: 'QUÉBEC' });

    const noGeometry = parseNtsIndexKml('<Placemark><name>021L14</name></Placemark>');
    expect(noGeometry.get('021L14')).toEqual({});
  });

  it('drops out-of-range and malformed coordinate tokens', () => {
    const ring = ['-71.5,46.75,0', 'junk', '-999,1000,0', '-71,47,0'].join('  ');
    expect(parseNtsIndexKml(placemark('021L14', 'QUÉBEC', ring)).get('021L14')?.bbox).toEqual([
      -71.5, 46.75, -71, 47,
    ]);
  });

  it('survives junk, blank snippets and an unterminated placemark', () => {
    expect(parseNtsIndexKml('').size).toBe(0);
    expect(parseNtsIndexKml('<kml><Document/></kml>').size).toBe(0);
    expect(parseNtsIndexKml('<Placemark><name>021L14</name>').size).toBe(0);
    expect(parseNtsIndexKml(placemark('021L14', '   ', QUEBEC_RING)).get('021L14')).toEqual({
      bbox: [-71.5, 46.75, -71, 47],
    });
  });
});
