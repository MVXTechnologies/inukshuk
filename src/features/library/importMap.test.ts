/**
 * The PDF import path (#236).
 *
 * Two outcomes must never be confused, because the fix for one is the opposite
 * of the fix for the other:
 *
 * - A PDF that parses but carries NO georeferencing is a real import. It lands
 *   in the library with `activePages: []` and a warning, and the card explains
 *   that it cannot be placed on the map.
 * - A PDF whose bytes cannot be read back is a FAILURE. `parseGeoPdf` never
 *   throws — it degrades to warnings — so the only way `mapDocumentFromStoredPdf`
 *   throws is that the stored file is unreadable, and a MapDocument over an
 *   unreadable file can be neither drawn nor opened. Such a file is not added,
 *   its copy is deleted rather than orphaned, and the reason reaches the user.
 */
import { type ByteSource, memoryByteSource } from '@core/geo/geopdf';
import { buildClassicPdf } from '@core/geo/geopdf/testUtils';
import * as storage from '@data/storage';
import * as DocumentPicker from 'expo-document-picker';
import { reportError } from '@lib/errorReporting';
import {
  WHOLE_FILE_PARSE_LIMIT_BYTES,
  mapDocumentFromStoredPdf,
  pickAndImportMaps,
} from './importMap';

jest.mock('@data/storage', () => ({
  newId: jest.fn(() => 'new-id'),
  importPdf: jest.fn(),
  withFileByteSource: jest.fn(),
  readFileBytes: jest.fn(),
  fileSizeAt: jest.fn(() => 1024),
  deleteFileAt: jest.fn(),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const mocked = storage as jest.Mocked<typeof storage>;
const picker = DocumentPicker as jest.Mocked<typeof DocumentPicker>;

/** A one-page PDF with a /VP + /Measure /GEO viewport. */
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

/** A one-page PDF with no georeferencing at all. */
const PLAIN_PDF = buildClassicPdf(
  [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ],
  1,
);

/**
 * `withFileByteSource` hands the parser random access to the stored file
 * (#328); in tests the "file" is an in-memory PDF.
 */
const serving =
  (bytes: Uint8Array) =>
  <T>(_uri: string, fn: (source: ByteSource) => T): T =>
    fn(memoryByteSource(bytes));
const unreadable = (message: string) => (): never => {
  throw new Error(message);
};

const pickAssets = (...names: string[]) => {
  picker.getDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: names.map((name) => ({
      uri: `file:///cache/${name}`,
      name,
      size: 1,
      mimeType: 'application/pdf',
    })),
  } as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);
};

beforeEach(() => {
  mocked.newId.mockReturnValue('new-id');
  mocked.importPdf.mockImplementation((_src: string, id: string) =>
    Promise.resolve(`file:///maps/${id}.pdf`),
  );
});

describe('mapDocumentFromStoredPdf', () => {
  it('activates every georeferenced page of a GeoPDF', async () => {
    mocked.withFileByteSource.mockImplementation(serving(GEO_PDF));
    const doc = await mapDocumentFromStoredPdf('m1', 'file:///maps/m1.pdf', 'Sheet');
    expect(doc.georeferences.length).toBeGreaterThan(0);
    expect(doc.activePages).toEqual([0]);
    expect(doc.georeferenceWarning).toBeUndefined();
  });

  it('imports an ungeoreferenced PDF, flagged and with no active page', async () => {
    mocked.withFileByteSource.mockImplementation(serving(PLAIN_PDF));
    const doc = await mapDocumentFromStoredPdf('m2', 'file:///maps/m2.pdf', 'Leaflet');
    expect(doc.georeferences).toEqual([]);
    expect(doc.activePages).toEqual([]);
    expect(doc.georeferenceWarning).toBeDefined();
  });

  it('deletes the stored copy when the bytes cannot be read', async () => {
    mocked.withFileByteSource.mockImplementation(unreadable('file not found'));
    mocked.readFileBytes.mockRejectedValue(new Error('file not found'));
    await expect(mapDocumentFromStoredPdf('m3', 'file:///maps/m3.pdf', 'Broken')).rejects.toThrow(
      'file not found',
    );
    expect(mocked.deleteFileAt).toHaveBeenCalledWith('file:///maps/m3.pdf');
  });

  // #328 moved parsing onto the platform's FileHandle. `parseGeoPdf` never
  // throws, so a throw here is that handle — a native path this app had no
  // reliance on before. A small file must still import the old way rather
  // than fail, and a big one must NOT (the whole-file read is the OOM the
  // random-access path exists to avoid).
  describe('whole-file fallback when the platform file handle fails', () => {
    it('parses a small map the old way, keeps it, and reports the handle failure', async () => {
      mocked.withFileByteSource.mockImplementation(unreadable('file handle is closed'));
      mocked.fileSizeAt.mockReturnValue(2 * 1024 * 1024);
      mocked.readFileBytes.mockResolvedValue(GEO_PDF);

      const doc = await mapDocumentFromStoredPdf('m4', 'file:///maps/m4.pdf', 'Fallback');

      expect(doc.georeferences).toHaveLength(1);
      expect(doc.activePages).toEqual([0]);
      expect(mocked.deleteFileAt).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'pdf-import-byte-source');
    });

    it('refuses to read a file too big to survive it, and fails as before', async () => {
      mocked.withFileByteSource.mockImplementation(unreadable('file handle is closed'));
      mocked.fileSizeAt.mockReturnValue(WHOLE_FILE_PARSE_LIMIT_BYTES + 1);

      await expect(mapDocumentFromStoredPdf('m5', 'file:///maps/m5.pdf', 'Huge')).rejects.toThrow(
        'file handle is closed',
      );
      expect(mocked.readFileBytes).not.toHaveBeenCalled();
      expect(mocked.deleteFileAt).toHaveBeenCalledWith('file:///maps/m5.pdf');
    });

    it('still fails when the fallback read fails too, with the original reason', async () => {
      mocked.withFileByteSource.mockImplementation(unreadable('file handle is closed'));
      mocked.fileSizeAt.mockReturnValue(1024);
      mocked.readFileBytes.mockRejectedValue(new Error('ENOSPC'));

      await expect(mapDocumentFromStoredPdf('m6', 'file:///maps/m6.pdf', 'Gone')).rejects.toThrow(
        'file handle is closed',
      );
      expect(mocked.deleteFileAt).toHaveBeenCalledWith('file:///maps/m6.pdf');
    });
  });
});

describe('pickAndImportMaps', () => {
  it('surfaces the reason and adds nothing when the only PDF fails', async () => {
    pickAssets('broken.pdf');
    mocked.withFileByteSource.mockImplementation(unreadable('file not found'));

    const result = await pickAndImportMaps();

    // An `error` result is what LibraryScreen turns into "Import failed: …".
    // The old `{ imported, docs: [], failed: 1 }` said "Imported 0 maps, 1
    // failed" and never why.
    expect(result).toEqual({ kind: 'error', message: 'file not found' });
  });

  it('keeps the PDFs that worked and counts the ones that did not', async () => {
    pickAssets('good.pdf', 'broken.pdf');
    mocked.withFileByteSource
      .mockImplementationOnce(serving(GEO_PDF))
      .mockImplementationOnce(unreadable('file not found'));

    const result = await pickAndImportMaps();

    expect(result.kind).toBe('imported');
    if (result.kind !== 'imported') throw new Error('unreachable');
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0]?.name).toBe('good');
    expect(result.docs[0]?.activePages).toEqual([0]);
    expect(result.failed).toBe(1);
  });

  it('reports a cancelled pick as cancelled, not as a failure', async () => {
    picker.getDocumentAsync.mockResolvedValue({ canceled: true, assets: null } as Awaited<
      ReturnType<typeof DocumentPicker.getDocumentAsync>
    >);
    expect(await pickAndImportMaps()).toEqual({ kind: 'canceled' });
  });
});
