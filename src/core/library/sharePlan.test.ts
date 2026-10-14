import type { Area, MapDocument, TrackSummary, Waypoint } from '@core/models';

import {
  catalogLink,
  isCatalogMap,
  linkHost,
  linksNote,
  linksText,
  sendCopyLines,
  sharePlan,
  waypointsContents,
  zipContentsLine,
  zipFileList,
  type ShareInput,
  type SharePlan,
} from './sharePlan';

const map = (id: string, over: Partial<MapDocument> = {}): MapDocument => ({
  id,
  name: `Map ${id}`,
  fileUri: `file:///${id}.pdf`,
  importedAt: 1,
  pageCount: 1,
  georeferences: [],
  activePages: [],
  ...over,
});
const catalog = (id: string, over: Partial<MapDocument> = {}) =>
  map(id, {
    name: 'Rivière du Berger',
    sourceItemId: `cpa-${id}`,
    sourceCredit: 'André Faubert',
    sourceFreeAt: 'cartespleinair.org',
    sourcePageUrl: `https://cartespleinair.org/carte/${id}`,
    ...over,
  });
const track = (id: string, name = `Trail ${id}`): TrackSummary =>
  ({ id, name, fileUri: `file:///${id}.gpx`, startedAt: 1, stats: {} }) as TrackSummary;
const waypoint = (id: string, label = `Waypoint ${id}`): Waypoint => ({
  id,
  label,
  latitude: 47,
  longitude: -71,
  createdAt: 1,
});
const area = (id: string): Area => ({
  id,
  name: `Area ${id}`,
  ring: [
    [-71, 47],
    [-70, 47],
    [-70, 46],
  ],
  color: '#2563EB',
  createdAt: 1,
});

const plan = (over: Partial<ShareInput>): SharePlan | null =>
  sharePlan({ maps: [], tracks: [], waypoints: [], areas: [], lang: 'en', ...over });

describe('sharePlan', () => {
  it('nothing to share is no plan', () => {
    expect(plan({})).toBeNull();
  });

  it('one trail goes as its GPX, under its name', () => {
    expect(plan({ tracks: [track('t1', 'Mont Jacques-Cartier')] })).toEqual({
      kind: 'gpx',
      fileName: 'Mont Jacques-Cartier.gpx',
      sourceUri: 'file:///t1.gpx',
    });
  });

  it('one personal map goes as its PDF', () => {
    expect(plan({ maps: [map('m1', { name: 'Mont-Albert — sentiers' })] })).toEqual({
      kind: 'pdf',
      fileName: 'Mont-Albert — sentiers.pdf',
      sourceUri: 'file:///m1.pdf',
    });
  });

  it('catalog maps go only as links with the author credit, never the file', () => {
    const p = plan({ maps: [catalog('a')] });
    expect(p).toEqual({
      kind: 'link',
      links: [
        {
          name: 'Rivière du Berger',
          credit: 'André Faubert · Available free at cartespleinair.org',
          url: 'https://cartespleinair.org/carte/a',
        },
      ],
      message:
        'Rivière du Berger\nAndré Faubert · Available free at cartespleinair.org\nhttps://cartespleinair.org/carte/a',
    });
    expect(JSON.stringify(p)).not.toContain('file:///');
  });

  it('only waypoints or areas: one GPX, named after a single one', () => {
    const many = plan({ waypoints: [waypoint('w1'), waypoint('w2')], areas: [area('a1')] });
    expect(many).toMatchObject({
      kind: 'waypoints',
      fileName: 'Waypoints.gpx',
      waypoints: 2,
      areas: 1,
    });
    expect(many?.kind === 'waypoints' && many.text).toContain('<inukshuk:area>');
    expect(plan({ waypoints: [waypoint('w1', 'Belvédère')] })).toMatchObject({
      kind: 'waypoints',
      fileName: 'Belvédère.gpx',
    });
    expect(plan({ areas: [area('a1')] })).toMatchObject({ fileName: 'Area a1.gpx' });
  });

  it('a mixed selection is a zip: GPX per trail, one Waypoints.gpx, PDFs, and links as text', () => {
    const p = plan({
      maps: [map('m1', { name: 'Mont-Albert' }), catalog('c1')],
      tracks: [track('t1', 'Loop'), track('t2', 'Loop')],
      waypoints: [waypoint('w1')],
    });
    if (p?.kind !== 'zip') throw new Error('expected a zip');
    expect(p.fileName).toBe('Inukshuk · 5 items.zip');
    expect(p.files).toEqual([
      { path: 'Mont-Albert.pdf', sourceUri: 'file:///m1.pdf', kind: 'pdf' },
      { path: 'Loop.gpx', sourceUri: 'file:///t1.gpx', kind: 'gpx' },
      { path: 'Loop-2.gpx', sourceUri: 'file:///t2.gpx', kind: 'gpx' },
    ]);
    expect(p.texts.map((t) => [t.path, t.kind])).toEqual([
      ['Waypoints.gpx', 'waypoints'],
      ['Catalog maps.txt', 'links'],
    ]);
    // The catalog PDF is never packed.
    expect(p.files.some((f) => f.sourceUri === 'file:///c1.pdf')).toBe(false);
    expect(zipContentsLine(p)).toBe('3 GPX + 1 PDF');
    expect(zipFileList(p)).toEqual([
      { icon: 'pdf', label: 'Mont-Albert.pdf' },
      { icon: 'gpx', label: 'Loop.gpx' },
      { icon: 'gpx', label: 'Loop-2.gpx' },
      { icon: 'waypoints', label: 'Waypoints.gpx (1 waypoint)' },
      { icon: 'links', label: 'Catalog maps.txt (1 link)' },
    ]);
  });

  it('a folder is a zip named after it, even for one item', () => {
    const p = plan({ tracks: [track('t1')], folderName: 'Gaspésie 2026' });
    expect(p).toMatchObject({ kind: 'zip', fileName: 'Gaspésie 2026.zip', trails: 1 });
    // A folder of catalog maps only is still links.
    expect(plan({ maps: [catalog('a')], folderName: 'F' })?.kind).toBe('link');
  });

  it('one trail plus a catalog map is a zip (the link goes inside as text)', () => {
    expect(plan({ tracks: [track('t1')], maps: [catalog('a')] })?.kind).toBe('zip');
  });

  it('lists many files of a kind as one line', () => {
    const p = plan({
      tracks: ['1', '2', '3', '4', '5'].map((i) => track(i)),
      maps: ['a', 'b', 'c', 'd'].map((i) => map(i)),
      areas: [area('x')],
    });
    if (p?.kind !== 'zip') throw new Error('expected a zip');
    expect(zipFileList(p)).toEqual([
      { icon: 'pdf', label: '4 maps as .pdf' },
      { icon: 'gpx', label: '5 trails as .gpx' },
      { icon: 'waypoints', label: 'Waypoints.gpx (1 area)' },
    ]);
    expect(zipContentsLine(p)).toBe('6 GPX + 4 PDF');
  });
});

describe('catalog links', () => {
  it('is a catalog map when it came from the catalog', () => {
    expect(isCatalogMap(catalog('a'))).toBe(true);
    expect(isCatalogMap(map('a'))).toBe(false);
  });

  it('falls back to the publisher host, and to no link at all', () => {
    expect(catalogLink(catalog('a', { sourcePageUrl: undefined }), 'fr')).toEqual({
      name: 'Rivière du Berger',
      credit: 'André Faubert · Disponible gratuitement sur cartespleinair.org',
      url: 'https://cartespleinair.org',
    });
    const bare = catalogLink(map('b', { sourceItemId: 'x', name: 'Sheet 21L14' }), 'en');
    expect(bare).toEqual({ name: 'Sheet 21L14', credit: null, url: null });
    expect(linksText([bare, catalogLink(catalog('a'), 'en')])).toBe(
      'Sheet 21L14\n\nRivière du Berger\nAndré Faubert · Available free at cartespleinair.org\nhttps://cartespleinair.org/carte/a',
    );
  });
});

describe('waypointsContents', () => {
  it('reads what a Waypoints file holds', () => {
    expect(waypointsContents(2, 0)).toBe('2 waypoints');
    expect(waypointsContents(1, 1)).toBe('1 waypoint · 1 area');
    expect(waypointsContents(0, 3)).toBe('3 areas');
  });
});

describe('the Send a copy lines', () => {
  it('say the file, then what is inside and the size', () => {
    expect(sendCopyLines(plan({ tracks: [track('t', 'Loop')] })!, 412_000)).toEqual([
      'Loop.gpx',
      '412 KB',
    ]);
    expect(sendCopyLines(plan({ tracks: [track('t', 'Loop')] })!, 0)).toEqual(['Loop.gpx', null]);
    expect(sendCopyLines(plan({ waypoints: [waypoint('a'), waypoint('b')] })!, 2_000)).toEqual([
      'Waypoints.gpx',
      '2 waypoints · 2 KB',
    ]);
    const zip = plan({ tracks: [track('1'), track('2')], maps: [map('m')] })!;
    expect(sendCopyLines(zip, 19_300_000)).toEqual([
      'Inukshuk · 3 items.zip',
      '2 GPX + 1 PDF · 19 MB',
    ]);
  });

  it('name a link by its host, never a file', () => {
    expect(sendCopyLines(plan({ maps: [catalog('a')] })!, 0)).toEqual([
      'The cartespleinair.org link',
      'with the author credit',
    ]);
    expect(sendCopyLines(plan({ maps: [catalog('a'), catalog('b')] })!, 0)).toEqual([
      '2 cartespleinair.org links',
      'with the author credits',
    ]);
    const bare = map('x', { sourceItemId: 'x' });
    expect(sendCopyLines(plan({ maps: [bare] })!, 0)[0]).toBe('The link');
    expect(sendCopyLines(plan({ maps: [bare, catalog('a')] })!, 0)[0]).toBe('2 links');
  });

  it('a zip that leaves catalog maps out says so', () => {
    const one = [catalogLink(catalog('a'), 'en')];
    expect(linksNote([])).toBeNull();
    expect(linksNote(one)).toBe(
      'Rivière du Berger goes as a link. Catalog maps are shared as their page on cartespleinair.org, with the author credit, never as the file.',
    );
    expect(linksNote([...one, { name: 'X', credit: null, url: 'https://example.org/x' }])).toBe(
      '2 catalog maps go as links. They are shared as their page, with the author credit, never as the file.',
    );
    expect(linkHost([{ name: 'X', credit: null, url: 'not a url' }])).toBeNull();
  });
});
