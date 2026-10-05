import { strToU8, zipSync } from 'fflate';

import type { CatalogItem } from '@core/catalog/schema';

import { downloadCatalogPdf } from './catalogDownload';
import * as storage from './storage';

const mockStaged = { bytes: new Uint8Array() };

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class {
    exists = true;
    create(): void {}
  },
  File: class {
    uri: string;
    constructor(dir: unknown, name: string) {
      this.uri = `file:///cache/catalog/${name}`;
    }
    get exists(): boolean {
      return false;
    }
    delete(): void {}
  },
}));
jest.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: () => ({
    downloadAsync: async () => ({ status: 200 }),
    cancelAsync: async () => undefined,
  }),
}));
jest.mock('./storage', () => ({
  readFileHead: jest.fn((_uri: string, n: number) => mockStaged.bytes.subarray(0, n)),
  fileSizeAt: jest.fn(() => mockStaged.bytes.length),
  readFileBytes: jest.fn(async () => mockStaged.bytes),
  adoptMapPdf: jest.fn((id: string) => `file:///doc/maps/${id}.pdf`),
  writeMapPdfBytes: jest.fn((id: string) => `file:///doc/maps/${id}.pdf`),
}));

const item = {
  id: 'ustopo-ga-abbottsford',
  url: 'https://example.test/GA_Abbottsford.pdf',
  sizeBytes: 57_983_038,
} as unknown as CatalogItem;

const pdf = (marker: string) => strToU8(`%PDF-1.7\n% ${marker}\n%%EOF`);

beforeEach(() => jest.clearAllMocks());

// #345: a 200 MB sheet read whole OOMs a 256 MB heap.
it('moves a bare PDF into the maps store without reading it', async () => {
  mockStaged.bytes = pdf('sheet');
  const uri = await downloadCatalogPdf(item, 'map1', () => undefined).promise;
  expect(uri).toBe('file:///doc/maps/map1.pdf');
  expect(storage.adoptMapPdf).toHaveBeenCalledWith('map1', 'file:///cache/catalog/map1.part');
  expect(storage.readFileBytes).not.toHaveBeenCalled();
  expect(storage.writeMapPdfBytes).not.toHaveBeenCalled();
});

it('still unpacks the PDF out of a (small) zip', async () => {
  mockStaged.bytes = zipSync({ 'readme.txt': strToU8('hi'), 'sheet.pdf': pdf('in zip') });
  await downloadCatalogPdf(item, 'map2', () => undefined).promise;
  expect(storage.readFileBytes).toHaveBeenCalledTimes(1);
  expect(storage.writeMapPdfBytes).toHaveBeenCalledWith('map2', pdf('in zip'));
  expect(storage.adoptMapPdf).not.toHaveBeenCalled();
});

it('refuses a download that is neither a PDF nor a zip with a PDF in it', async () => {
  mockStaged.bytes = strToU8('<html>Not found</html>');
  await expect(downloadCatalogPdf(item, 'map3', () => undefined).promise).rejects.toThrow(
    'does not contain a PDF map',
  );
});
