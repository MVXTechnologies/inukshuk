import type { OverlayRenderStatus } from './overlayStatus';
import { renderingToasts } from './renderingToasts';

const maps = [
  { id: 'a', name: 'Anticosti', activePages: [0] },
  { id: 'b', name: 'Nord', activePages: [2, 0] },
];

describe('renderingToasts', () => {
  it('lists rendering pages in library and page order, with the map name', () => {
    expect(
      renderingToasts(
        maps,
        {
          'a:0': { phase: 'rendered' },
          'b:0': { phase: 'rendering' },
          'b:2': { phase: 'rendering' },
        },
        new Map(),
      ),
    ).toEqual([
      { key: 'b:0', text: 'Rendering Nord — page 1…' },
      { key: 'b:2', text: 'Rendering Nord — page 3…' },
    ]);
  });

  it('omits failed/rendered pages', () => {
    expect(renderingToasts(maps, { 'b:0': { phase: 'failed', reason: 'x' } }, new Map())).toEqual(
      [],
    );
  });

  // A hide is bound to the status object that was showing: the same page
  // rendering again later is a new object, and must announce itself again.
  it('hides a row only while the status it hid is still current', () => {
    const rendering: OverlayRenderStatus = { phase: 'rendering' };
    const hidden = new Map([['a:0', rendering]]);
    expect(renderingToasts(maps, { 'a:0': rendering }, hidden)).toEqual([]);
    expect(renderingToasts(maps, { 'a:0': { phase: 'rendering' } }, hidden)).toHaveLength(1);
  });
});

// The toasts are for the map the user is looking at. A background pre-render
// (#272 step 2) is nothing the map waits for, so it never toasts — the
// Library card carries "Preparing page N…" instead.
it('never toasts a page that is only being pre-rendered', () => {
  expect(renderingToasts(maps, { 'a:0': { phase: 'preparing' } }, new Map())).toEqual([]);
});
