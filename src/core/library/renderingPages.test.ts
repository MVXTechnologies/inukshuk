import { renderingPages } from './renderingPages';

const maps = [
  { id: 'a', name: 'Anticosti', activePages: [0] },
  { id: 'b', name: 'Nord', activePages: [2, 0] },
];

describe('renderingPages', () => {
  it('lists rendering pages in library and page order, with the map name', () => {
    expect(
      renderingPages(maps, {
        'a:0': { phase: 'rendered' },
        'b:0': { phase: 'rendering' },
        'b:2': { phase: 'rendering' },
      }),
    ).toEqual([
      { key: 'b:0', name: 'Nord', page: 1 },
      { key: 'b:2', name: 'Nord', page: 3 },
    ]);
  });

  it('omits failed/rendered pages', () => {
    expect(renderingPages(maps, { 'b:0': { phase: 'failed', reason: 'x' } })).toEqual([]);
  });
});

// The chip is for the map the user is looking at. A background pre-render
// (#272 step 2) is nothing the map waits for, so it never shows — the
// Library card carries "Preparing page N…" instead.
it('never lists a page that is only being pre-rendered', () => {
  expect(renderingPages(maps, { 'a:0': { phase: 'preparing' } })).toEqual([]);
});
