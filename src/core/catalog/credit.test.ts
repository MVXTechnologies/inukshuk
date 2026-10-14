import { creditLine, freeAvailabilityLine, itemCredit, sourceFreeLine } from './credit';

describe('itemCredit', () => {
  it('names the author and the year, verbatim', () => {
    expect(itemCredit({ author: 'Charles Leduc', year: 2023 })).toBe('Charles Leduc · 2023');
    expect(itemCredit({ author: 'Leduc/Boisclair' })).toBe('Leduc/Boisclair');
  });

  it('never credits anyone when the author is unknown', () => {
    expect(itemCredit({})).toBeUndefined();
    expect(itemCredit({ author: '   ', year: 2020 })).toBeUndefined();
  });
});

describe('free availability', () => {
  it('uses the publisher’s recommended French wording on a French device', () => {
    expect(freeAvailabilityLine('cartespleinair.org', 'fr')).toBe(
      'Disponible gratuitement sur cartespleinair.org',
    );
    expect(freeAvailabilityLine('cartespleinair.org', 'en')).toBe(
      'Available free at cartespleinair.org',
    );
  });

  it('only for a source whose terms ask for it', () => {
    expect(sourceFreeLine({ freeAt: 'cartespleinair.org' }, 'en')).toBe(
      'Available free at cartespleinair.org',
    );
    expect(sourceFreeLine({}, 'en')).toBeUndefined();
    expect(sourceFreeLine(undefined, 'fr')).toBeUndefined();
  });
});

describe('creditLine', () => {
  it('joins the credit and the free line', () => {
    expect(creditLine('Charles Leduc · 2023', 'cartespleinair.org', 'en')).toBe(
      'Charles Leduc · 2023 · Available free at cartespleinair.org',
    );
    expect(creditLine(undefined, 'cartespleinair.org', 'fr')).toBe(
      'Disponible gratuitement sur cartespleinair.org',
    );
    expect(creditLine(' André Faubert ', undefined, 'en')).toBe('André Faubert');
  });

  it('is undefined for an ordinary map', () => {
    expect(creditLine(undefined, undefined, 'en')).toBeUndefined();
    expect(creditLine('', '', 'en')).toBeUndefined();
  });
});
