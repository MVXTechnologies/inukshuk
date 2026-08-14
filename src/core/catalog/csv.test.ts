import { csvColumnIndex, parseCsvLine, splitCsvRows } from './csv';

describe('parseCsvLine', () => {
  it('splits plain fields', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps commas inside quotes — the bug this module exists to prevent', () => {
    // Verbatim shape of a USGS ustopo_current.csv row: a quoted county list
    // sits between the state and the bounding box.
    const row = 'Abbeville East,Alabama,"Henry, Barbour",-85.25,-85.125,31.625,31.5';
    const fields = parseCsvLine(row);
    expect(fields).toHaveLength(7);
    expect(fields[2]).toBe('Henry, Barbour');
    // The bbox must still be in columns 3–6, not shifted one to the right.
    expect(fields.slice(3)).toEqual(['-85.25', '-85.125', '31.625', '31.5']);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsvLine('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c']);
  });

  it('preserves empty fields, including trailing ones', () => {
    expect(parseCsvLine('a,,c,')).toEqual(['a', '', 'c', '']);
    expect(parseCsvLine('')).toEqual(['']);
  });

  it('treats a quoted empty field as empty', () => {
    expect(parseCsvLine('a,"",c')).toEqual(['a', '', 'c']);
  });
});

describe('splitCsvRows', () => {
  it('splits on newlines and tolerates CRLF', () => {
    expect(splitCsvRows('a,b\r\nc,d\n')).toEqual(['a,b', 'c,d']);
  });

  it('keeps a newline that lives inside a quoted field', () => {
    const rows = splitCsvRows('a,"line1\nline2"\nc,d\n');
    expect(rows).toHaveLength(2);
    expect(parseCsvLine(rows[0] ?? '')[1]).toBe('line1\nline2');
  });

  it('drops trailing blank lines', () => {
    expect(splitCsvRows('a,b\n\n')).toEqual(['a,b']);
  });
});

describe('csvColumnIndex', () => {
  it('maps requested names to their positions', () => {
    expect(csvColumnIndex(['map_name', 'westbc', 'eastbc'], ['eastbc', 'map_name'])).toEqual({
      eastbc: 2,
      map_name: 0,
    });
  });

  it('throws when upstream drops a column instead of yielding undefined rows', () => {
    expect(() => csvColumnIndex(['map_name'], ['westbc'])).toThrow(/no "westbc" column/);
  });
});
