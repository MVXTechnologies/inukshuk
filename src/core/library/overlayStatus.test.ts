import { overlayStatusKey, renderStatusLine, retainStatuses } from './overlayStatus';

const map = { id: 'm1', activePages: [0, 1] };

describe('renderStatusLine', () => {
  it('is silent when nothing is pending or failed', () => {
    expect(renderStatusLine(map, {})).toBeNull();
    expect(
      renderStatusLine(map, { 'm1:0': { phase: 'rendered' }, 'm1:1': { phase: 'rendered' } }),
    ).toBeNull();
  });

  it('names the page being rendered', () => {
    expect(
      renderStatusLine(map, { 'm1:0': { phase: 'rendered' }, 'm1:1': { phase: 'rendering' } }),
    ).toEqual({ kind: 'rendering', text: 'Rendering page 2…' });
  });

  // The failure is what the user can act on (re-import, report, delete); a
  // page still rendering must not hide it.
  it('reports a failure ahead of a page still rendering, with the reason', () => {
    expect(
      renderStatusLine(map, {
        'm1:0': { phase: 'rendering' },
        'm1:1': { phase: 'failed', reason: 'render timed out after 45000ms' },
      }),
    ).toEqual({ kind: 'failed', text: "Couldn't render page 2: render timed out after 45000ms" });
  });

  it('ignores other maps and inactive pages', () => {
    expect(
      renderStatusLine(map, {
        'm2:0': { phase: 'failed', reason: 'x' },
        'm1:7': { phase: 'rendering' },
      }),
    ).toBeNull();
  });

  it('visits pages in page order even when activePages is not sorted', () => {
    expect(
      renderStatusLine(
        { id: 'm1', activePages: [3, 1, 1] },
        { 'm1:1': { phase: 'failed', reason: 'a' }, 'm1:3': { phase: 'failed', reason: 'b' } },
      )?.text,
    ).toBe("Couldn't render page 2: a");
  });
});

describe('retainStatuses', () => {
  it('drops keys no longer live and keeps the same object when nothing changed', () => {
    const statuses = {
      'm1:0': { phase: 'rendered' as const },
      'm2:0': { phase: 'rendering' as const },
    };
    expect(retainStatuses(statuses, ['m1:0'])).toEqual({ 'm1:0': { phase: 'rendered' } });
    expect(retainStatuses(statuses, ['m1:0', 'm2:0'])).toBe(statuses);
  });
});

describe('overlayStatusKey', () => {
  it('matches the overlay id format', () => {
    expect(overlayStatusKey('abc', 2)).toBe('abc:2');
  });
});

it('shows detail failure after overview success and preserves overview failure priority', () => {
  expect(
    renderStatusLine(map, {
      'm1:0': { phase: 'rendered' },
      'm1:0:detail': { phase: 'failed', reason: 'timeout' },
    }),
  ).toEqual({ kind: 'failed', text: "Couldn't render page 1 detail: timeout" });
  expect(
    renderStatusLine(map, {
      'm1:0': { phase: 'failed', reason: 'overview' },
      'm1:0:detail': { phase: 'failed', reason: 'detail' },
    })?.text,
  ).toBe("Couldn't render page 1: overview");
});
it('shows refinement loading while retaining the completed overview status', () => {
  expect(
    renderStatusLine(map, { 'm1:0': { phase: 'rendered' }, 'm1:0:detail': { phase: 'rendering' } }),
  ).toEqual({ kind: 'rendering', text: 'Rendering page 1 detail…' });
});
it('retains detail statuses with their active page and drops inactive detail statuses', () => {
  expect(
    retainStatuses(
      { 'm1:0:detail': { phase: 'failed', reason: 'x' }, 'm1:1:detail': { phase: 'rendering' } },
      ['m1:0'],
    ),
  ).toEqual({ 'm1:0:detail': { phase: 'failed', reason: 'x' } });
});
