import { formatLatLng, formatLatLngDdm, formatLatLngDms } from './formatCoords';
import { parseLatLng } from './parseCoords';

describe('formatLatLng', () => {
  it('formats five decimals in lat, lng order', () => {
    expect(formatLatLng(46.813944, -71.208201)).toBe('46.81394, -71.20820');
  });

  it('pads short values to a stable width', () => {
    expect(formatLatLng(46.8, -71.2)).toBe('46.80000, -71.20000');
  });

  it('handles the southern/western hemispheres and zero', () => {
    expect(formatLatLng(-33.856784, 151.215297)).toBe('-33.85678, 151.21530');
    expect(formatLatLng(0, 0)).toBe('0.00000, 0.00000');
  });
});

describe('formatLatLngDdm', () => {
  it('formats degrees and decimal minutes with hemisphere letters', () => {
    expect(formatLatLngDdm(46.8139, -71.2082)).toBe("46°48.834'N, 71°12.492'W");
    expect(formatLatLngDdm(-33.8688, 151.2093)).toBe("33°52.128'S, 151°12.558'E");
  });

  it('pads the minutes to a stable width', () => {
    expect(formatLatLngDdm(46.05, -71.0)).toBe("46°03.000'N, 71°00.000'W");
  });

  it('carries a rounded 60 into the next degree', () => {
    // 46.99999999° is 46°59.9999994' — which must print as 47°00.000', never 46°60.000'.
    expect(formatLatLngDdm(46.99999999, 0)).toBe("47°00.000'N, 0°00.000'E");
  });

  it('treats zero as the positive hemispheres', () => {
    expect(formatLatLngDdm(0, 0)).toBe("0°00.000'N, 0°00.000'E");
  });
});

describe('formatLatLngDms', () => {
  it('formats degrees, minutes and seconds with hemisphere letters', () => {
    expect(formatLatLngDms(46.8139, -71.2082)).toBe('46°48\'50.0"N, 71°12\'29.5"W');
    expect(formatLatLngDms(-33.8688, 151.2093)).toBe('33°52\'07.7"S, 151°12\'33.5"E');
  });

  it('carries a rounded 60 through minutes and into the degrees', () => {
    expect(formatLatLngDms(46.99999999, 0)).toBe('47°00\'00.0"N, 0°00\'00.0"E');
    // 46.516666° = 46°30'59.998" — the seconds carry into the 31st minute.
    expect(formatLatLngDms(46.5166666, 0)).toBe('46°31\'00.0"N, 0°00\'00.0"E');
  });
});

describe('formatted coordinates round-trip through parseLatLng', () => {
  it.each([
    [46.8139, -71.2082],
    [-33.8688, 151.2093],
    [0, 0],
    [83.1, -70.5],
    [-45.25, 179.99],
  ])('%p, %p', (lat, lng) => {
    for (const text of [
      formatLatLng(lat, lng),
      formatLatLngDdm(lat, lng),
      formatLatLngDms(lat, lng),
    ]) {
      const back = parseLatLng(text);
      expect(back).not.toBeNull();
      // DMS is the coarsest of the three (0.1" ≈ 3 m), so that sets the tolerance.
      expect(back?.latitude).toBeCloseTo(lat, 4);
      expect(back?.longitude).toBeCloseTo(lng, 4);
    }
  });
});
