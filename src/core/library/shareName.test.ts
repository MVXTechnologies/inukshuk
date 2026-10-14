import { pdfShareName, shareFileName } from './shareName';

describe('shareFileName', () => {
  it('names any shared file after its title, with its own extension and fallback', () => {
    expect(shareFileName('Mont Jacques-Cartier', 'gpx', 'Trail')).toBe('Mont Jacques-Cartier.gpx');
    expect(shareFileName('Gaspésie: 2026', 'zip', 'Inukshuk')).toBe('Gaspésie 2026.zip');
    expect(shareFileName(' ', 'gpx', 'Trail')).toBe('Trail.gpx');
  });
});

describe('pdfShareName', () => {
  it('is the map title, readable, accents kept', () => {
    expect(pdfShareName('Rivière du Nord (Dumoine) 2022')).toBe(
      'Rivière du Nord (Dumoine) 2022.pdf',
    );
  });

  it('drops what file systems refuse, and leading dots', () => {
    expect(pdfShareName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j.pdf');
    expect(pdfShareName('..hidden\n\tname')).toBe('hidden name.pdf');
  });

  it('caps the length and never returns an empty name', () => {
    expect(pdfShareName('x'.repeat(200))).toBe(`${'x'.repeat(80)}.pdf`);
    expect(pdfShareName('  //  ')).toBe('Map.pdf');
    expect(pdfShareName('')).toBe('Map.pdf');
  });
});
