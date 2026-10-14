import { MAP_DATA_CREDITS } from './mapDataCredits';

describe('MAP_DATA_CREDITS', () => {
  it('credits the canoe maps the way their publisher asked (#680)', () => {
    expect(MAP_DATA_CREDITS).toContain(
      'Canoe maps: Cartes Plein-air (cartespleinair.org), each map by its own author, available free at cartespleinair.org',
    );
    // The river locations come from the CGNDB, under its licence.
    expect(MAP_DATA_CREDITS).toContain(
      'Canadian Geographical Names Database (NRCan, Open Government Licence – Canada)',
    );
  });
});
