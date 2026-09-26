import { DEFAULT_PRINT_STYLE, PRINT_STYLES, printStyleById } from './printSources';

describe('PRINT_STYLES', () => {
  it('gives every style both halves of the promise: a drape and a live template', () => {
    for (const s of PRINT_STYLES) {
      expect(s.drape).toBeTruthy();
      expect(s.tileUrl).toContain('{z}');
      expect(s.tileUrl).toContain('{x}');
      expect(s.tileUrl).toContain('{y}');
      expect(s.attribution).toMatch(/Esri/);
    }
  });

  it('keeps Esri row-before-column order — {z}/{y}/{x}, not {z}/{x}/{y}', () => {
    // Swapping these silently serves tiles from the wrong place, which is
    // exactly the kind of drift this module exists to prevent.
    for (const s of PRINT_STYLES) {
      expect(s.tileUrl.endsWith('/{z}/{y}/{x}')).toBe(true);
    }
  });

  it('has unique ids and unique drapes', () => {
    expect(new Set(PRINT_STYLES.map((s) => s.id)).size).toBe(PRINT_STYLES.length);
    expect(new Set(PRINT_STYLES.map((s) => s.drape)).size).toBe(PRINT_STYLES.length);
  });

  it('never drapes `relief`, which has no tile source to stitch', () => {
    for (const s of PRINT_STYLES) expect(s.drape).not.toBe('relief');
  });
});

describe('printStyleById', () => {
  it('resolves each id', () => {
    expect(printStyleById('street').drape).toBe('map');
    expect(printStyleById('imagery').drape).toBe('satellite');
  });

  it('falls back to the first style rather than returning undefined', () => {
    expect(printStyleById('nope' as never).id).toBe(PRINT_STYLES[0]!.id);
  });

  it('has a default that exists', () => {
    expect(PRINT_STYLES.some((s) => s.id === DEFAULT_PRINT_STYLE)).toBe(true);
  });
});
