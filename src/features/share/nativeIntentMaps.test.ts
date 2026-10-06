/**
 * "Open with Inukshuk" on a PDF (#246): the intent handler must sniff the
 * content and route a PDF to the map import, not down the GPX path. Runs the
 * real sniffing (`openImportedUri`) and the real map import over fixture PDFs;
 * only the file system and the stores are faked.
 */
import { memoryByteSource } from '@core/geo/geopdf';
import { buildClassicPdf } from '@core/geo/geopdf/testUtils';
import { NO_GEOREFERENCE_NOTICE } from '@core/library/overlayPages';
import type { MapDocument } from '@core/models';
import * as storage from '@data/storage';
import { importGpxFromUri } from '@features/library/importGpx';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';

import { redirectSystemPath } from '../../../app/+native-intent';

const mockShow = jest.fn();
const addMap = jest.fn();

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
jest.mock('@lib/strava', () => ({ handleStravaAuthRedirect: () => false }));
jest.mock('@state/importFeedbackStore', () => ({
  useImportFeedbackStore: { getState: () => ({ show: mockShow }) },
}));
jest.mock('@state/libraryStore', () => ({ useLibraryStore: { getState: jest.fn() } }));
jest.mock('@features/library/importGpx', () => ({ importGpxFromUri: jest.fn() }));
jest.mock('@data/trackGeometry', () => ({ primeTrackGeometry: jest.fn() }));
jest.mock('@data/trailStatsStore', () => ({ primeTrailStats: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: jest.fn(() => 'map-1'),
  readFileHead: jest.fn(),
  copyToImportCache: jest.fn(),
  importPdf: jest.fn(async (_uri: string, id: string) => `file:///doc/maps/${id}.pdf`),
  withFileByteSource: jest.fn(),
  fileSizeAt: jest.fn(() => 1024),
  readFileBytes: jest.fn(),
  deleteFileAt: jest.fn(),
}));

const mocked = storage as jest.Mocked<typeof storage>;

/** A one-page PDF with a /VP + /Measure /GEO viewport (as in importMap.test). */
const GEO_PDF = buildClassicPdf(
  [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /VP [ << /Type /Viewport ' +
      '/BBox [0 0 612 792] /Measure << /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0] ' +
      '/GPTS [46.7 -71.3 46.9 -71.3 46.9 -71.1 46.7 -71.1] /LPTS [0 0 0 1 1 1 1 0] ' +
      '/GCS << /Type /GEOGCS /EPSG 4326 >> >> >> ] >>',
  ],
  1,
);
const PLAIN_PDF = buildClassicPdf(
  [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ],
  1,
);

/** Serve `bytes` as the file behind every uri. */
function serve(bytes: Uint8Array) {
  mocked.readFileHead.mockImplementation((_uri, length) => bytes.slice(0, length));
  mocked.withFileByteSource.mockImplementation((_uri, fn) => fn(memoryByteSource(bytes)));
}

const open = (path: string) => redirectSystemPath({ path, initial: false });

beforeEach(() => {
  jest.mocked(useLibraryStore.getState).mockReturnValue({
    tracks: [],
    hydrate: async () => {},
    addMap,
  } as unknown as ReturnType<typeof useLibraryStore.getState>);
});

it('imports a georeferenced PDF from Files/Mail as a map, named after the file', async () => {
  serve(GEO_PDF);
  const path = 'file:///private/var/mobile/Containers/Data/Inbox/Mont%20Tremblant.pdf';
  await expect(open(path)).resolves.toBe('/(tabs)/library');
  expect(mocked.importPdf).toHaveBeenCalledWith(path, 'map-1');
  const doc = addMap.mock.calls[0]?.[0] as MapDocument;
  expect(doc).toMatchObject({ id: 'map-1', name: 'Mont Tremblant', activePages: [0] });
  expect(doc.georeferences).toHaveLength(1);
  expect(mockShow).toHaveBeenLastCalledWith('Imported Mont Tremblant');
  expect(importGpxFromUri).not.toHaveBeenCalled();
});

it('recognizes a PDF by content behind an opaque content:// uri', async () => {
  serve(GEO_PDF);
  await expect(open('content://media/external/downloads/1000000094')).resolves.toBe(
    '/(tabs)/library',
  );
  expect(addMap).toHaveBeenCalledWith(expect.objectContaining({ name: 'Imported map' }));
  expect(importGpxFromUri).not.toHaveBeenCalled();
});

it('imports a PDF without georeferencing, and says it cannot be placed', async () => {
  serve(PLAIN_PDF);
  await expect(open('file:///Inbox/Brochure.pdf')).resolves.toBe('/(tabs)/library');
  expect(addMap).toHaveBeenCalledWith(expect.objectContaining({ activePages: [] }));
  expect(mockShow).toHaveBeenLastCalledWith(`Imported Brochure. ${NO_GEOREFERENCE_NOTICE}`);
});

it('a PDF that cannot be copied is a failed import, with the failure snackbar', async () => {
  serve(GEO_PDF);
  mocked.importPdf.mockRejectedValueOnce(new Error('ENOSPC'));
  await expect(open('file:///Inbox/Big.pdf')).resolves.toBe('/(tabs)/library');
  expect(addMap).not.toHaveBeenCalled();
  expect(mockShow).toHaveBeenLastCalledWith('Could not import that file');
  expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'open-with-import');
});

it('a provider that reports no size is copied to the cache, sniffed there, and cleaned up', async () => {
  serve(GEO_PDF);
  mocked.readFileHead.mockImplementation((uri, length) =>
    uri.startsWith('content://') ? new Uint8Array() : GEO_PDF.slice(0, length),
  );
  mocked.copyToImportCache.mockResolvedValue('file:///cache/imports/x.import');
  await expect(open('content://provider/doc/7')).resolves.toBe('/(tabs)/library');
  expect(mocked.importPdf).toHaveBeenCalledWith('file:///cache/imports/x.import', 'map-1');
  expect(mocked.deleteFileAt).toHaveBeenCalledWith('file:///cache/imports/x.import');
  expect(addMap).toHaveBeenCalled();
});

it('a GPX still takes the GPX path', async () => {
  serve(new TextEncoder().encode('<?xml version="1.0"?><gpx version="1.1"><trk></trk></gpx>'));
  jest.mocked(importGpxFromUri).mockRejectedValueOnce(new Error('No track points'));
  await open('file:///Inbox/Walk.gpx');
  expect(importGpxFromUri).toHaveBeenCalled();
  expect(addMap).not.toHaveBeenCalled();
});
