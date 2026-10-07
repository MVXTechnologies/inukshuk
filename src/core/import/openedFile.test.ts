import { looksLikePdf, mapNameFromUri, sniffOpenedFile } from './openedFile';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('looksLikePdf', () => {
  it('finds the %PDF- header at the start or behind leading junk', () => {
    expect(looksLikePdf(bytes('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toBe(true);
    expect(looksLikePdf(bytes(`${' '.repeat(500)}%PDF-1.4`))).toBe(true);
  });

  it('rejects a header past the first kilobyte, a truncated one, or none', () => {
    expect(looksLikePdf(bytes(`${' '.repeat(1100)}%PDF-1.4`))).toBe(false);
    expect(looksLikePdf(bytes('%PDF'))).toBe(false);
    expect(looksLikePdf(bytes('<?xml version="1.0"?><gpx>'))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });
});

describe('sniffOpenedFile (#246)', () => {
  it('classifies a PDF by content, whatever the uri says', () => {
    expect(sniffOpenedFile(bytes('%PDF-1.6'), 'content://media/external/downloads/42')).toBe('pdf');
    expect(sniffOpenedFile(bytes('%PDF-1.6'), 'file:///x/Trail.gpx')).toBe('pdf');
  });

  it('keeps the activity formats', () => {
    expect(sniffOpenedFile(bytes('<?xml version="1.0"?><gpx version="1.1">'))).toBe('gpx');
    expect(sniffOpenedFile(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe('gzip');
  });

  it('falls back to a .pdf name only when the content says nothing', () => {
    expect(sniffOpenedFile(new Uint8Array([1, 2, 3]), 'file:///Inbox/Map.PDF')).toBe('pdf');
    expect(sniffOpenedFile(new Uint8Array([1, 2, 3]), 'content://media/1')).toBe('unknown');
  });
});

describe('mapNameFromUri', () => {
  it('uses the file name without its extension', () => {
    expect(mapNameFromUri('file:///var/mobile/Inbox/Mont%20Tremblant.pdf')).toBe('Mont Tremblant');
    expect(
      mapNameFromUri(
        'content://com.android.externalstorage.documents/document/primary%3ADownload%2FSheet%2021L.pdf',
      ),
    ).toBe('Sheet 21L');
    expect(mapNameFromUri('content://x/document/1A2B-3C4D%3Atopo.pdf?x=1')).toBe('topo');
    expect(mapNameFromUri('file:///Inbox/Carte 1:50k.pdf')).toBe('Carte 1:50k');
  });

  it('falls back when the uri names no PDF', () => {
    expect(mapNameFromUri('content://media/external/downloads/1000000094')).toBe('Imported map');
    expect(mapNameFromUri('content://x/.pdf', 'Map')).toBe('Map');
    expect(mapNameFromUri('file:///Inbox/bad%E0.pdf')).toBe('bad%E0');
  });
});
