import { ntsSheetBbox, parseNtsSheetId } from './nts';

describe('parseNtsSheetId', () => {
  it('parses the common spellings', () => {
    expect(parseNtsSheetId('021L14')).toEqual({ quad: 21, letter: 'L', number: 14 });
    expect(parseNtsSheetId('21l14')).toEqual({ quad: 21, letter: 'L', number: 14 });
    expect(parseNtsSheetId('031_g_05')).toEqual({ quad: 31, letter: 'G', number: 5 });
  });

  it('rejects junk and out-of-model ids', () => {
    expect(parseNtsSheetId('')).toBeNull();
    expect(parseNtsSheetId('021L17')).toBeNull(); // sheets stop at 16
    expect(parseNtsSheetId('021L00')).toBeNull();
    expect(parseNtsSheetId('021Q14')).toBeNull(); // letters stop at P
    expect(parseNtsSheetId('020L14')).toBeNull(); // row 0 does not exist
    expect(parseNtsSheetId('025A01')).toBeNull(); // ≥60°N: high-latitude belts unmodelled
    expect(parseNtsSheetId('028L14')).toBeNull(); // ≥68°N uses wider quads
    expect(parseNtsSheetId('not-a-sheet')).toBeNull();
  });
});

describe('ntsSheetBbox', () => {
  it('places Québec City (021L14) exactly', () => {
    expect(ntsSheetBbox('021L14')).toEqual([-71.5, 46.75, -71, 47]);
  });

  it('places the southeast corner sheet of a quad', () => {
    // 021A01: letter A is the SE 2°×1° quad of 64–72°W/44–48°N; sheet 01 its
    // SE 0.5°×0.25° cell.
    expect(ntsSheetBbox('021A01')).toEqual([-64.5, 44, -64, 44.25]);
  });

  it('places the northwest corner sheet of a quad', () => {
    // 021M13: M is the NW letter quad (row 4 runs west→east, M first at the
    // west edge); sheet 13 is its NW cell.
    expect(ntsSheetBbox('021M13')).toEqual([-72, 47.75, -71.5, 48]);
  });

  it('handles the snake direction on even letter rows', () => {
    // Ottawa's 031G05: G is row 2 (E–H, west→east) so G sits one column west
    // of the east edge; sheet 05 opens row 2 of the numbers at the west edge.
    expect(ntsSheetBbox('031G05')).toEqual([-76, 45.25, -75.5, 45.5]);
  });

  it('is null for unparseable ids', () => {
    expect(ntsSheetBbox('woods')).toBeNull();
  });
});
