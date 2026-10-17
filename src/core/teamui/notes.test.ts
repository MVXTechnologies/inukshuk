import { noteBody, seenBody } from '@core/domains/team/notes';
import { HOUR, MIN, T0 } from '@core/team/testing/fixtures';
import { advertisedCapBody, capBody, NOTE_CAP } from '@core/teamdraw/caps';
import { crew } from '@core/teamdraw/testUtils';
import { alertContext, alertFor } from './alerts';

import type { PinNote, TeamPin } from './pins';
import {
  FADED_OPACITY,
  isNote,
  lifeLeft,
  newsKey,
  NOTE_COLLAPSE_ZOOM,
  noteArrival,
  noteMarks,
  noteOpacity,
  noteSections,
  noteSpan,
  noteUnread,
  seenCount,
  seenLine,
  type NotePin,
} from './notes';

const NOTE: PinNote = {
  text: 'Hut water is dry',
  color: 1,
  expiresAt: T0 + 10 * HOUR,
  fadeFrom: T0,
  newsAt: T0,
  edited: false,
};

function mk(
  id: string,
  owner: string,
  over: Partial<PinNote> = {},
  at: [number, number] = [-71.2, 46.8],
): NotePin {
  return {
    id,
    owner,
    lng: at[0],
    lat: at[1],
    messages: [{ id, author: owner, text: 'x', at: T0, mentions: [] }],
    lastAt: T0,
    note: { ...NOTE, ...over },
  };
}
const never = () => 0;

describe('fade and age', () => {
  it('stays opaque until the last fifth, then fades to half', () => {
    expect(noteOpacity(NOTE, T0 + HOUR)).toBe(1);
    expect(noteOpacity(NOTE, T0 + 8 * HOUR)).toBe(1);
    expect(noteOpacity(NOTE, T0 + 9 * HOUR)).toBeCloseTo((FADED_OPACITY + 1) / 2, 2);
    expect(noteOpacity(NOTE, T0 + 10 * HOUR)).toBe(FADED_OPACITY);
    expect(lifeLeft(NOTE, T0 - HOUR)).toBe(1);
    expect(lifeLeft({ ...NOTE, fadeFrom: NOTE.expiresAt }, T0)).toBe(1);
  });
  it('says ages and time left like the mockups', () => {
    expect(noteSpan(20_000)).toBe('now');
    expect(noteSpan(12 * MIN)).toBe('12 min');
    expect(noteSpan(HOUR + 2 * MIN)).toBe('1 h');
    expect(noteSpan(3 * HOUR + 40 * MIN)).toBe('3 h 40');
    expect(noteSpan(22 * HOUR + 30 * MIN)).toBe('22 h');
    expect(noteSpan(3 * 24 * HOUR)).toBe('3 d');
    expect(noteSpan(-5)).toBe('now');
  });
  it('is unread until opened after its news, never mine', () => {
    const p = mk('a', 'julie', { newsAt: T0 + 5 });
    expect(noteUnread(p, 'me', never)).toBe(true);
    expect(noteUnread(p, 'me', () => T0 + 5)).toBe(false);
    expect(noteUnread(p, 'julie', never)).toBe(false);
  });
});

describe('the note list', () => {
  const pins: TeamPin[] = [
    mk('j', 'julie', { newsAt: T0 + 3 }),
    mk('s', 'sam', { newsAt: T0 + 4 }),
    mk('n', 'noe', { newsAt: T0 + 2 }),
    mk('m', 'me', { newsAt: T0 + 1 }),
    mk('old', 'julie', { expiresAt: T0 + HOUR, newsAt: T0 }),
    mk('gone', 'julie', { expiresAt: T0 - 2 * 24 * HOUR }),
    { ...mk('plain', 'alex'), note: null },
  ];
  const seen = (th: string) => (th === 'pin:noe:n' ? T0 + 9 : 0);
  const now = T0 + 2 * HOUR;

  it('splits New / Earlier / Faded (last 24 h), newest first, with counts', () => {
    const s = noteSections(pins, 'me', seen, now, 'all');
    expect(s.fresh.map((r) => r.pin.id)).toEqual(['s', 'j']);
    expect(s.earlier.map((r) => r.pin.id)).toEqual(['n', 'm']);
    expect(s.faded.map((r) => r.pin.id)).toEqual(['old']);
    expect(s.counts).toEqual({ all: 4, new: 2, mine: 1 });
  });
  it('filters New and Mine', () => {
    const fresh = noteSections(pins, 'me', seen, now, 'new');
    expect([...fresh.fresh, ...fresh.earlier, ...fresh.faded].map((r) => r.pin.id)).toEqual([
      's',
      'j',
    ]);
    const mine = noteSections(pins, 'me', seen, now, 'mine');
    expect([...mine.fresh, ...mine.earlier, ...mine.faded].map((r) => r.pin.id)).toEqual(['m']);
  });
  it('announces the newest unread note whose news is not known yet', () => {
    const none = new Set<string>();
    expect(noteArrival(pins, 'me', seen, none, now)?.id).toBe('s');
    const known = new Set(
      pins
        .filter(isNote)
        .map(newsKey)
        .filter((k) => k.startsWith('sam:')),
    );
    expect(noteArrival(pins, 'me', seen, known, now)?.id).toBe('j');
    expect(noteArrival(pins, 'me', () => Infinity, none, now)).toBeNull();
    // Edited text is news again.
    const edited = [mk('s', 'sam', { newsAt: T0 + 50 })];
    expect(noteArrival(edited, 'me', seen, known, now)?.id).toBe('s');
  });
});

describe('callouts and tiles', () => {
  const near = (id: string, dx: number, newsAt: number) =>
    mk(id, 'julie', { newsAt }, [-71.2 + dx, 46.8]);

  it('a callout per note when apart; a tile with a count where they would overlap', () => {
    const pins = [near('a', 0, 3), near('b', 0.0001, 2), near('c', 0.05, 1)];
    const marks = noteMarks(pins, 15, T0, () => false);
    expect(marks.map((m) => [m.kind, m.kind === 'tile' ? m.pins.length : 1])).toEqual([
      ['tile', 2],
      ['callout', 1],
    ]);
    const tile = marks[0]!;
    expect(tile.kind === 'tile' && tile.pins[0]?.id).toBe('a');
  });
  it(`only tiles below zoom ${NOTE_COLLAPSE_ZOOM}; expired notes are gone`, () => {
    const pins = [near('a', 0, 3), near('c', 0.5, 1), mk('x', 'sam', { expiresAt: T0 })];
    const marks = noteMarks(pins, NOTE_COLLAPSE_ZOOM - 1, T0, (p) => p.id === 'c');
    expect(marks.map((m) => m.kind)).toEqual(['tile', 'tile']);
    expect(marks.map((m) => m.kind === 'tile' && m.unread)).toEqual([false, true]);
  });
  it('is the same for any input order', () => {
    const pins = [near('a', 0, 3), near('b', 0.0001, 2), near('c', 0.0002, 1), near('d', 0.3, 0)];
    const a = noteMarks(pins, 15, T0, () => false);
    const b = noteMarks([...pins].reverse(), 15, T0, () => false);
    expect(b).toEqual(a);
  });
});

describe('arrival', () => {
  it('a note arrives silently (badge); with "Alert team" it buzzes (alert)', () => {
    const at = T0 + 10 * MIN;
    const { rb, re, eve, sync } = crew();
    const quiet = rb.write(at, 'msg', { id: 'q', th: `pin:${rb.id}:q`, tx: 'Quiet', ll: [0, 0] })!;
    const loud = rb.write(
      at + 1,
      'msg',
      { id: 'l', th: `pin:${rb.id}:l`, tx: 'Loud', ll: [0, 0] },
      { pr: 1 },
    )!;
    sync(at + 2);
    const ctx = alertContext(re.state, re.data(at + 2));
    const body = (op: typeof quiet) => re.decode(op);
    expect(alertFor(re.state, quiet, body(quiet), eve.id, ctx)?.level).toBe('badge');
    expect(alertFor(re.state, loud, body(loud), eve.id, ctx)).toMatchObject({
      level: 'alert',
      url: `/team/pin/${rb.id}/l`,
    });
  });
});

describe('Seen by', () => {
  it('counts receipts over the members that can send one', () => {
    const at = T0 + 10 * MIN;
    const { rb, re, rg, w, sync } = crew();
    rb.write(at, 'msg', { id: 'p1', th: `pin:${rb.id}:p1`, tx: 'Note', ll: [-71.2, 46.8] });
    rb.write(at + 1, 'e.set', noteBody('p1', { col: 1, fx: at + HOUR }));
    sync(at + 2);
    const members = [w.root.id, rb.id, re.id, rg.id];
    expect(seenLine(seenCount(rb.data(), rb.id, 'p1', members, at + 3))).toBe('—');
    re.write(at + 3, 'e.set', advertisedCapBody(re.id, at + 3));
    rg.write(at + 3, 'e.set', advertisedCapBody(rg.id, at + 3));
    re.write(at + 4, 'e.set', seenBody(rb.id, 'p1', at + 4));
    sync(at + 5);
    const c = seenCount(rb.data(), rb.id, 'p1', members, at + 6);
    expect(c).toEqual({ seen: 1, capable: 2 });
    expect(seenLine(c)).toBe('1 of 2');
    // `nt` is 2.7's claim: the 2.6 record (what older phones write) stays without it.
    expect(advertisedCapBody(re.id, at).f[NOTE_CAP]).toBe(1);
    expect(capBody(re.id, at).f[NOTE_CAP]).toBeUndefined();
  });
});
