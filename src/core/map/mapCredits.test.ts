import { mapCredits, type MapCreditsInput } from './mapCredits';

const base: MapCreditsInput = {
  basemap: 'map',
  vector: true,
  osmLabels: false,
  terrain: false,
  pdfMaps: [],
  routingEngines: null,
};

const ids = (input: Partial<MapCreditsInput>) => mapCredits({ ...base, ...input }).map((l) => l.id);

it('credits the vector map and its peaks with OpenStreetMap and Protomaps', () => {
  const lines = mapCredits(base);
  expect(lines.map((l) => l.id)).toEqual(['base', 'peaks', 'regions']);
  expect(lines[0]?.credit).toBe('© OpenStreetMap contributors · Protomaps');
  expect(lines[0]?.link?.url).toBe('https://www.openstreetmap.org/copyright');
});

it('credits the raster map with OpenStreetMap only, and no vector peaks', () => {
  const lines = mapCredits({ ...base, vector: false });
  expect(lines.map((l) => l.id)).toEqual(['base']);
  expect(lines[0]?.credit).toBe('© OpenStreetMap contributors');
});

it('credits Esri on satellite, plus OSM when its labels ride the imagery', () => {
  expect(ids({ basemap: 'satellite', vector: false })).toEqual(['imagery']);
  const withLabels = mapCredits({ ...base, basemap: 'satellite', vector: false, osmLabels: true });
  expect(withLabels.map((l) => l.id)).toEqual(['imagery', 'labels', 'peaks', 'regions']);
  expect(withLabels[0]?.credit).toContain('Esri');
  expect(withLabels[1]?.credit).toContain('OpenStreetMap');
});

it('credits Natural Earth for the province names wherever the vector labels are drawn', () => {
  const regions = mapCredits(base).find((l) => l.id === 'regions');
  expect(regions?.credit).toBe('Natural Earth (public domain)');
  expect(regions?.link?.url).toMatch(/^https:\/\/www\.naturalearthdata\.com\//);
  expect(ids({ vector: false })).not.toContain('regions');
  expect(ids({ basemap: 'satellite', vector: false })).not.toContain('regions');
});

it('lists contours/relief only while terrain is drawn', () => {
  expect(ids({ terrain: true })).toContain('terrain');
  expect(ids({ terrain: false })).not.toContain('terrain');
  const terrain = mapCredits({ ...base, terrain: true }).find((l) => l.id === 'terrain');
  expect(terrain?.credit).toMatch(/Terrain Tiles/);
  expect(terrain?.link?.url).toMatch(/^https:\/\//);
});

it('names the PDF maps on screen, capping a long list', () => {
  const one = mapCredits({ ...base, pdfMaps: ['Mont-Tremblant'] }).find((l) => l.id === 'pdf');
  expect(one?.label).toBe('PDF map');
  expect(one?.credit).toBe("Mont-Tremblant — © each map's publisher");
  const many = mapCredits({ ...base, pdfMaps: ['A', 'B', 'C', 'D', 'E'] }).find(
    (l) => l.id === 'pdf',
  );
  expect(many?.label).toBe('PDF maps');
  expect(many?.credit).toBe("A, B, C and 2 more — © each map's publisher");
});

it('shows the routing engine only while a routed route is on screen', () => {
  expect(ids({ routingEngines: null })).not.toContain('routing');
  // Routed, engine unnamed (a saved route reopened): OSM is still credited.
  expect(mapCredits({ ...base, routingEngines: [] }).find((l) => l.id === 'routing')?.credit).toBe(
    '© OpenStreetMap contributors',
  );
  const routing = mapCredits({ ...base, routingEngines: ['BRouter', 'Valhalla'] }).find(
    (l) => l.id === 'routing',
  );
  expect(routing?.credit).toBe('BRouter + Valhalla · © OpenStreetMap contributors');
  expect(routing?.link).toEqual({ label: 'BRouter', url: 'https://brouter.de' });
  const unknown = mapCredits({ ...base, routingEngines: ['Acme'] }).find((l) => l.id === 'routing');
  expect(unknown?.credit).toBe('Acme · © OpenStreetMap contributors');
  expect(unknown?.link).toBeUndefined();
});

it('adds weather and marine only when they are drawn', () => {
  expect(ids({})).not.toContain('weather');
  expect(ids({})).not.toContain('marine');
  expect(ids({ weather: true, marine: true })).toEqual(
    expect.arrayContaining(['weather', 'marine']),
  );
  const marine = mapCredits({ ...base, marine: true }).find((l) => l.id === 'marine');
  expect(marine?.credit).toMatch(/Not for navigation/);
});

it('gives every line a non-empty label and credit', () => {
  const all = mapCredits({
    ...base,
    basemap: 'satellite',
    osmLabels: true,
    terrain: true,
    pdfMaps: ['X'],
    routingEngines: ['Valhalla'],
    weather: true,
    marine: true,
  });
  expect(all).toHaveLength(9);
  for (const line of all) {
    expect(line.label.length).toBeGreaterThan(0);
    expect(line.credit.length).toBeGreaterThan(0);
  }
});

it('credits the climbing crags with their three open sources', () => {
  expect(ids({ climbing: true })).toContain('climbing');
  const line = mapCredits({ ...base, climbing: true }).find((l) => l.id === 'climbing');
  expect(line?.credit).toContain('OpenBeta (CC0)');
  expect(line?.credit).toContain('OpenStreetMap contributors (ODbL)');
  expect(line?.credit).toContain('camptocamp.org (CC BY-SA)');
});
