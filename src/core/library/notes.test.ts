import type { TrackNote } from '@core/models';

import { numberNotesOnTrack, orderNotes, removeNoteById, updateNoteText } from './notes';

const note = (id: string, distanceM: number, createdAt = 0, text = `note-${id}`): TrackNote => ({
  id,
  distanceM,
  text,
  createdAt,
});

describe('orderNotes', () => {
  it('orders by distance along the trail', () => {
    const ordered = orderNotes([note('a', 500), note('b', 100), note('c', 300)]);
    expect(ordered.map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties by creation time so numbering is stable', () => {
    const ordered = orderNotes([note('a', 100, 20), note('b', 100, 10)]);
    expect(ordered.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input', () => {
    const input = [note('a', 2), note('b', 1)];
    orderNotes(input);
    expect(input.map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('removeNoteById / updateNoteText', () => {
  it('removes only the matching note', () => {
    const out = removeNoteById([note('a', 1), note('b', 2)], 'a');
    expect(out.map((n) => n.id)).toEqual(['b']);
  });

  it('updates and trims the matching note text only', () => {
    const out = updateNoteText([note('a', 1, 0, 'old'), note('b', 2, 0, 'keep')], 'a', '  new  ');
    expect(out.find((n) => n.id === 'a')!.text).toBe('new');
    expect(out.find((n) => n.id === 'b')!.text).toBe('keep');
  });
});

describe('numberNotesOnTrack', () => {
  // A straight track along longitude at 45° lat; each 0.002° step ≈ 157 m.
  const tp = (longitude: number): { latitude: number; longitude: number; time: number } => ({
    latitude: 45,
    longitude,
    time: 0,
  });
  const track = [tp(-73), tp(-72.998), tp(-72.996)];

  it('numbers notes 1..N in trail order regardless of insertion order', () => {
    const out = numberNotesOnTrack(track, [note('far', 250), note('near', 50)]);
    expect(out.map((n) => [n.note.id, n.num])).toEqual([
      ['near', 1],
      ['far', 2],
    ]);
  });

  it('anchors each note to its interpolated on-trail position', () => {
    const out = numberNotesOnTrack(track, [note('a', 0), note('b', 1e9)]);
    expect(out[0]!.longitude).toBeCloseTo(-73, 6);
    // Past the end clamps to the last point.
    expect(out[1]!.longitude).toBeCloseTo(-72.996, 6);
    expect(out.every((n) => Math.abs(n.latitude - 45) < 1e-9)).toBe(true);
  });

  it('matches the list numbering when distances tie (createdAt breaks the tie)', () => {
    const out = numberNotesOnTrack(track, [note('late', 100, 20), note('early', 100, 10)]);
    expect(out.map((n) => n.note.id)).toEqual(['early', 'late']);
  });

  it('returns nothing for an empty track', () => {
    expect(numberNotesOnTrack([], [note('a', 10)])).toEqual([]);
  });
});
