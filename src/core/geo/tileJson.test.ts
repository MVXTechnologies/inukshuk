import { tileTemplatesFromTileJson } from './tileJson';

describe('tileTemplatesFromTileJson', () => {
  it('extracts absolute templated tile URLs', () => {
    expect(
      tileTemplatesFromTileJson({
        tilejson: '3.0.0',
        tiles: ['https://tiles.openfreemap.org/planet/20260802_080001_pt/{z}/{x}/{y}.pbf'],
      }),
    ).toEqual(['https://tiles.openfreemap.org/planet/20260802_080001_pt/{z}/{x}/{y}.pbf']);
  });

  it('drops relative or untemplated entries and nulls when none survive', () => {
    expect(
      tileTemplatesFromTileJson({ tiles: ['/relative/{z}/{x}/{y}.pbf', 'https://x/no-template'] }),
    ).toBeNull();
    expect(
      tileTemplatesFromTileJson({
        tiles: ['/rel/{z}/{x}/{y}.pbf', 'https://ok/{z}/{x}/{y}.pbf'],
      }),
    ).toEqual(['https://ok/{z}/{x}/{y}.pbf']);
  });

  it('nulls on junk', () => {
    for (const junk of [null, 42, 'x', {}, { tiles: [] }, { tiles: 'nope' }]) {
      expect(tileTemplatesFromTileJson(junk)).toBeNull();
    }
  });
});
