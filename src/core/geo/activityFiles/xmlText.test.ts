import { parseGpx } from '@core/geo/gpx';

import { decodeActivityFile, sniffActivityFormat } from './decode';
import { decodeUtf8Strict, decodeXmlText, sniffXmlEncoding } from './xmlText';

const NAME = 'Sentier des Érables – boucle « Québec » ✓';
const gpx = (decl: string, name = NAME) =>
  `${decl}<gpx version="1.1"><trk><name>${name}</name><trkseg>` +
  '<trkpt lat="46.8" lon="-71.2"/><trkpt lat="46.801" lon="-71.2"/></trkseg></trk></gpx>';

const utf16le = (s: string, bom = true) =>
  new Uint8Array(Buffer.concat([Buffer.from(bom ? [0xff, 0xfe] : []), Buffer.from(s, 'utf16le')]));
const utf16be = (s: string) => {
  const le = Buffer.from(s, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1] ?? 0;
    be[i + 1] = le[i] ?? 0;
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
};

describe('decodeXmlText', () => {
  it('decodes UTF-8, with or without a BOM, unchanged', () => {
    const text = gpx('<?xml version="1.0" encoding="UTF-8"?>');
    expect(decodeXmlText(new TextEncoder().encode(text))).toBe(text);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(decodeXmlText(withBom)).toBe(text);
  });

  it('decodes a declared ISO-8859-1 file and re-declares it as UTF-8', () => {
    const latin = gpx('<?xml version="1.0" encoding="ISO-8859-1"?>', 'Sentier des Érables');
    const out = decodeXmlText(new Uint8Array(Buffer.from(latin, 'latin1')));
    expect(out).toContain('<name>Sentier des Érables</name>');
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('reads Windows-1252 punctuation in the 0x80–0x9F range', () => {
    // 0x96 en dash, 0x93/0x94 curly quotes, 0x80 euro sign.
    const bytes = new Uint8Array([
      ...Buffer.from("<?xml version='1.0' encoding='windows-1252'?><gpx><name>a", 'latin1'),
      0x96,
      0x93,
      0x80,
      0x94,
      ...Buffer.from('</name></gpx>', 'latin1'),
    ]);
    const out = decodeXmlText(bytes);
    expect(out).toContain('<name>a–“€”</name>');
    expect(out).toContain("encoding='UTF-8'");
  });

  it('falls back to Windows-1252 when an undeclared file is not valid UTF-8', () => {
    const latin = gpx('', 'Montée du Lac-à-l’Épaule');
    const bytes = new Uint8Array(Buffer.from(latin.replace('’', "'"), 'latin1'));
    expect(decodeXmlText(bytes)).toContain("Montée du Lac-à-l'Épaule");
  });

  it('decodes UTF-16 LE and BE with a BOM, and LE without one', () => {
    const text = gpx('<?xml version="1.0" encoding="UTF-16"?>');
    const expected = text.replace('UTF-16', 'UTF-8');
    expect(decodeXmlText(utf16le(text))).toBe(expected);
    expect(decodeXmlText(utf16be(text))).toBe(expected);
    expect(decodeXmlText(utf16le(text, false))).toBe(expected);
  });

  it('keeps astral characters intact', () => {
    const text = '<gpx><name>Summit 🏔️</name></gpx>';
    expect(decodeXmlText(new TextEncoder().encode(text))).toBe(text);
    expect(decodeXmlText(utf16le(text))).toBe(text);
  });

  it('decodes a large document without hitting argument limits', () => {
    const big = `<gpx>${'<trkpt lat="1" lon="2"/>'.repeat(200_000)}</gpx>`;
    expect(decodeXmlText(new TextEncoder().encode(big))).toHaveLength(big.length);
  });
});

describe('decodeUtf8Strict', () => {
  it.each([
    ['a lone continuation byte', [0x41, 0x80]],
    ['a truncated sequence', [0xe2, 0x82]],
    ['an overlong encoding', [0xc0, 0xaf]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
  ])('rejects %s', (_label, bytes) => {
    expect(decodeUtf8Strict(new Uint8Array(bytes))).toBeNull();
  });
});

describe('sniffXmlEncoding', () => {
  it('trusts a BOM over a declaration', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('<?xml encoding="latin1"?>')]);
    expect(sniffXmlEncoding(bytes)).toEqual({ encoding: 'utf-8', bom: 3 });
  });

  it('treats an unknown declaration as UTF-8', () => {
    expect(sniffXmlEncoding(new Uint8Array(Buffer.from('<?xml encoding="koi8-r"?>')))).toEqual({
      encoding: 'utf-8',
      bom: 0,
    });
  });
});

describe('activity import of non-UTF-8 GPX', () => {
  it('recognizes and decodes a UTF-16 GPX', () => {
    const bytes = utf16le(gpx('<?xml version="1.0" encoding="UTF-16"?>'));
    expect(sniffActivityFormat(bytes, 'export')).toBe('gpx');
    const [activity] = decodeActivityFile(bytes, 'export');
    expect(activity?.name).toBe(NAME);
    expect(activity?.points).toHaveLength(2);
    expect(activity?.gpxText).toContain('encoding="UTF-8"');
  });

  it('decodes a Latin-1 GPX with its accents', () => {
    const latin = gpx('<?xml version="1.0" encoding="ISO-8859-1"?>', 'Sentier des Érables');
    const [activity] = decodeActivityFile(new Uint8Array(Buffer.from(latin, 'latin1')), 'a.gpx');
    expect(activity?.name).toBe('Sentier des Érables');
    expect(parseGpx(activity?.gpxText ?? '').metadata.name).toBe('Sentier des Érables');
  });
});
