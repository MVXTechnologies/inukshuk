import { strToU8, zipSync } from 'fflate';
import { extractPdf, looksLikePdf } from './unzip';

const pdfBytes = (marker: string, pad = 0) =>
  strToU8(`%PDF-1.7\n% ${marker}\n${'x'.repeat(pad)}\n%%EOF`);

describe('looksLikePdf', () => {
  it('recognizes the %PDF magic', () => {
    expect(looksLikePdf(pdfBytes('a'))).toBe(true);
    expect(looksLikePdf(strToU8('PK\x03\x04not a pdf'))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
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
