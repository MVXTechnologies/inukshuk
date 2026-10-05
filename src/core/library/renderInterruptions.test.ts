import {
  INTERRUPTIONS_BEFORE_PAUSE,
  MAX_INTERRUPTION_ENTRIES,
  clearInterruptions,
  parseInterruptions,
  recordInterruption,
  type RenderInterruption,
} from './renderInterruptions';

const page = { filePath: 'maps/made.pdf', pageIndex: 0 };

describe('recordInterruption', () => {
  it('does not pause a page on its first interrupted render (a kill, not a crash)', () => {
    const { entries, pause } = recordInterruption([], { ...page, token: 'a' });
    expect(pause).toBe(false);
    expect(entries).toEqual([{ ...page, count: 1, token: 'a' }]);
  });

  it('pauses a page interrupted again before any render of it completed', () => {
    const first = recordInterruption([], { ...page, token: 'a' });
    const second = recordInterruption(first.entries, { ...page, token: 'b' });
    expect(INTERRUPTIONS_BEFORE_PAUSE).toBe(2);
    expect(second.pause).toBe(true);
    expect(second.entries).toEqual([{ ...page, count: 2, token: 'b' }]);
  });

  it('does not count the same checkpoint twice when the process dies before consuming it', () => {
    const first = recordInterruption([], { ...page, token: 'a' });
    const again = recordInterruption(first.entries, { ...page, token: 'a' });
    expect(again.pause).toBe(false);
    expect(again.entries).toEqual([{ ...page, count: 1, token: 'a' }]);
  });

  it('keeps strikes per page: another page or file does not add to them', () => {
    let entries: RenderInterruption[] = recordInterruption([], { ...page, token: 'a' }).entries;
    const other = recordInterruption(entries, { ...page, pageIndex: 1, token: 'b' });
    expect(other.pause).toBe(false);
    entries = recordInterruption(other.entries, {
      filePath: 'maps/other.pdf',
      pageIndex: 0,
      token: 'c',
    }).entries;
    const back = recordInterruption(entries, { ...page, token: 'd' });
    expect(back.pause).toBe(true);
    expect(back.entries.at(-1)).toEqual({ ...page, count: 2, token: 'd' });
    expect(back.entries).toHaveLength(3);
  });

  it('keeps counting past the threshold so a retried crashing page pauses at once', () => {
    let entries: RenderInterruption[] = [];
    for (const token of ['a', 'b', 'c'])
      entries = recordInterruption(entries, { ...page, token }).entries;
    expect(entries).toEqual([{ ...page, count: 3, token: 'c' }]);
  });

  it('is bounded, dropping the oldest page first', () => {
    let entries: RenderInterruption[] = [];
    for (let i = 0; i < MAX_INTERRUPTION_ENTRIES + 3; i++) {
      entries = recordInterruption(entries, {
        filePath: `maps/${i}.pdf`,
        pageIndex: 0,
        token: `${i}`,
      }).entries;
    }
    expect(entries).toHaveLength(MAX_INTERRUPTION_ENTRIES);
    expect(entries[0]?.filePath).toBe('maps/3.pdf');
  });
});

describe('clearInterruptions', () => {
  it('forgets only the page whose render completed', () => {
    const entries: RenderInterruption[] = [
      { ...page, count: 1, token: 'a' },
      { ...page, pageIndex: 1, count: 1, token: 'b' },
    ];
    expect(clearInterruptions(entries, page)).toEqual([entries[1]]);
    expect(clearInterruptions(entries, { filePath: 'maps/none.pdf', pageIndex: 0 })).toEqual(
      entries,
    );
  });
});

describe('parseInterruptions', () => {
  it('round-trips a stored list', () => {
    const entries = recordInterruption([], { ...page, token: 'a' }).entries;
    expect(parseInterruptions(JSON.parse(JSON.stringify({ version: 1, entries })))).toEqual(
      entries,
    );
  });

  it('drops malformed input and entries instead of throwing', () => {
    expect(parseInterruptions(null)).toEqual([]);
    expect(parseInterruptions('x')).toEqual([]);
    expect(parseInterruptions({ entries: 'x' })).toEqual([]);
    expect(
      parseInterruptions({
        entries: [
          null,
          { ...page, count: 0, token: 'a' },
          { ...page, count: 1.5, token: 'a' },
          { ...page, pageIndex: -1, count: 1, token: 'a' },
          { ...page, filePath: '', count: 1, token: 'a' },
          { ...page, count: 1, token: '' },
          { ...page, count: 1, token: 'x'.repeat(129) },
          { ...page, count: 1, token: 'ok' },
        ],
      }),
    ).toEqual([{ ...page, count: 1, token: 'ok' }]);
  });

  it('keeps one entry per page (the last) and stays bounded', () => {
    const many = Array.from({ length: MAX_INTERRUPTION_ENTRIES + 2 }, (_, i) => ({
      filePath: `maps/${i}.pdf`,
      pageIndex: 0,
      count: 1,
      token: `${i}`,
    }));
    const parsed = parseInterruptions({
      entries: [{ ...page, count: 1, token: 'old' }, ...many, { ...page, count: 2, token: 'new' }],
    });
    expect(parsed).toHaveLength(MAX_INTERRUPTION_ENTRIES);
    expect(parsed.at(-1)).toEqual({ ...page, count: 2, token: 'new' });
    expect(parsed.filter((entry) => entry.filePath === page.filePath)).toHaveLength(1);
  });
});
