import {
  NOTE_PREVIEW_MAX_CHARS,
  nextWaypointLabel,
  nextWaypointNumber,
  notePreview,
  sortWaypointsNewestFirst,
} from './waypoints';

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

// #232 — the same numbering the store stamps at creation and the editor
// pre-fills its Name field with; they MUST agree, or a name left untouched
// would change the numbering.
describe('nextWaypointNumber', () => {
  it('starts at 1 on an empty library', () => {
    expect(nextWaypointNumber([])).toBe(1);
    expect(nextWaypointLabel([])).toBe('Waypoint 1');
  });

  it('numbers past the highest auto label, not past the count', () => {
    // "Waypoint 1" deleted: the count says 2, but re-using 3 would duplicate.
    expect(nextWaypointNumber(['Waypoint 2', 'Waypoint 3'])).toBe(4);
  });

  it('ignores labels the user has renamed', () => {
    expect(nextWaypointNumber(['Camp', 'Source froide', 'Waypoint 2'])).toBe(3);
    expect(nextWaypointNumber(['Camp', 'Source froide'])).toBe(1);
  });

  it('ignores near-misses rather than guessing at them', () => {
    expect(nextWaypointNumber(['Waypoint', 'Waypoint 4b', 'waypoint 9', 'Waypoint 12 north'])).toBe(
      1,
    );
  });

  it('is order-independent', () => {
    expect(nextWaypointLabel(['Waypoint 7', 'Waypoint 2'])).toBe('Waypoint 8');
    expect(nextWaypointLabel(['Waypoint 2', 'Waypoint 7'])).toBe('Waypoint 8');
  });
});
