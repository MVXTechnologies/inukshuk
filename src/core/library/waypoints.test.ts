import { NOTE_PREVIEW_MAX_CHARS, notePreview, sortWaypointsNewestFirst } from './waypoints';

describe('sortWaypointsNewestFirst', () => {
  it('orders by createdAt descending', () => {
    const sorted = sortWaypointsNewestFirst([
      { id: 'a', createdAt: 100 },
      { id: 'c', createdAt: 300 },
      { id: 'b', createdAt: 200 },
    ]);
    expect(sorted.map((w) => w.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input and keeps stored order for ties', () => {
    const input = [
      { id: 'first', createdAt: 100 },
      { id: 'second', createdAt: 100 },
    ];
    const sorted = sortWaypointsNewestFirst(input);
    expect(sorted.map((w) => w.id)).toEqual(['first', 'second']);
    expect(input[0]?.id).toBe('first');
    expect(sorted).not.toBe(input);
  });

  it('handles an empty list', () => {
    expect(sortWaypointsNewestFirst([])).toEqual([]);
  });
});

describe('notePreview', () => {
  it('returns null for a missing, empty, or whitespace-only note', () => {
    expect(notePreview(undefined)).toBeNull();
    expect(notePreview('')).toBeNull();
    expect(notePreview('   \n\t ')).toBeNull();
  });

  it('passes a short note through, trimmed', () => {
    expect(notePreview('  Water source here  ')).toBe('Water source here');
  });

  it('collapses newlines and runs of whitespace to single spaces', () => {
    expect(notePreview('Line one\nLine two\n\n  Line   three')).toBe(
      'Line one Line two Line three',
    );
  });

  it('truncates long notes at the limit with an ellipsis', () => {
    const long = 'x'.repeat(NOTE_PREVIEW_MAX_CHARS + 20);
    const preview = notePreview(long);
    expect(preview).toBe(`${'x'.repeat(NOTE_PREVIEW_MAX_CHARS)}…`);
  });

  it('does not leave a trailing space before the ellipsis', () => {
    // 79 chars + a space at index 79: the cut lands on the space.
    const note = `${'a'.repeat(NOTE_PREVIEW_MAX_CHARS - 1)} tail words`;
    expect(notePreview(note)).toBe(`${'a'.repeat(NOTE_PREVIEW_MAX_CHARS - 1)}…`);
  });

  it('respects a custom max length', () => {
    expect(notePreview('abcdef', 4)).toBe('abcd…');
    expect(notePreview('abcd', 4)).toBe('abcd');
  });
});
