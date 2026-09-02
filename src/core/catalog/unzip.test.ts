import { strToU8, zipSync } from 'fflate';
import { extractPdf, isTiffEntryName, looksLikePdf, looksLikeTiff } from './unzip';

const pdfBytes = (marker: string, pad = 0) =>
  strToU8(`%PDF-1.7\n% ${marker}\n${'x'.repeat(pad)}\n%%EOF`);

describe('looksLikePdf', () => {
  it('recognizes the %PDF magic', () => {
    expect(looksLikePdf(pdfBytes('a'))).toBe(true);
    expect(looksLikePdf(strToU8('PK\x03\x04not a pdf'))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
  });
});

describe('looksLikeTiff', () => {
  it('recognizes both byte orders of a classic TIFF', () => {
    expect(looksLikeTiff(new Uint8Array([0x49, 0x49, 42, 0, 8]))).toBe(true);
    expect(looksLikeTiff(new Uint8Array([0x4d, 0x4d, 0, 42, 0]))).toBe(true);
  });

  it('rejects BigTIFF (version 43) — the decoder reads 32-bit offsets only', () => {
    expect(looksLikeTiff(new Uint8Array([0x49, 0x49, 43, 0, 8]))).toBe(false);
  });

  it('rejects a zip, a PDF and a runt buffer', () => {
    expect(looksLikeTiff(strToU8('PK\x03\x04'))).toBe(false);
    expect(looksLikeTiff(pdfBytes('a'))).toBe(false);
    expect(looksLikeTiff(new Uint8Array([0x49, 0x49]))).toBe(false);
  });
});

describe('isTiffEntryName', () => {
  it('matches the sheet raster and skips the metadata sidecar', () => {
    expect(isTiffEntryName('021l14_1_1.tif')).toBe(true);
    expect(isTiffEntryName('sheet.TIFF')).toBe(true);
    expect(isTiffEntryName('canmatrix_021l14_1_1_pna.xml')).toBe(false);
  });

  it('skips macOS resource forks', () => {
    expect(isTiffEntryName('__MACOSX/._021l14.tif')).toBe(false);
  });
});

describe('extractPdf', () => {
  it('extracts the PDF entry from a CanTopo-style zip', () => {
    const inner = pdfBytes('map sheet');
    const zip = zipSync({ 'cantopo_021l14.pdf': inner, 'readme.txt': strToU8('hello') });
    expect(extractPdf(zip)).toEqual(inner);
  });

  it('passes bare PDF bytes through (server unzipped it for us)', () => {
    const pdf = pdfBytes('bare');
    expect(extractPdf(pdf)).toBe(pdf);
  });

  it('prefers the largest PDF so a bundled legend cannot shadow the sheet', () => {
    const legend = pdfBytes('legend');
    const sheet = pdfBytes('sheet', 4096);
    const zip = zipSync({ 'legend.pdf': legend, 'sheet.pdf': sheet });
    expect(extractPdf(zip)).toEqual(sheet);
  });

  it('ignores macOS resource-fork entries', () => {
    const inner = pdfBytes('real');
    const zip = zipSync({
      '__MACOSX/._ghost.pdf': pdfBytes('ghost', 8192),
      'real.pdf': inner,
    });
    expect(extractPdf(zip)).toEqual(inner);
  });

  it('returns null for a zip without any PDF', () => {
    expect(extractPdf(zipSync({ 'readme.txt': strToU8('no maps here') }))).toBeNull();
  });

  it('returns null for a zip whose .pdf entry is not a PDF', () => {
    expect(extractPdf(zipSync({ 'fake.pdf': strToU8('plain text') }))).toBeNull();
  });

  it('returns null for corrupt bytes without throwing', () => {
    expect(extractPdf(strToU8('PK\x03\x04garbage'))).toBeNull();
    expect(extractPdf(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
