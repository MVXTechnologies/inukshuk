/**
 * Team notes (#706, 2.7.0 PR G8): the R-NOTE-1 sanitiser, the `pnm` / `pnr`
 * fold rules through the real replica, and mixed versions against the frozen
 * 2.6.1 fold (a 2.6 phone stores, relays and skips both kinds, and shows the
 * note as the plain pin it also is).
 */
import type { Json } from '@core/team/canonical';
import type { TeamData } from '@core/team/data';
import type { SignedOp } from '@core/team/envelope';
import { GroupReplica, type TeamReplica } from '@core/team/replica';
import { legacyApplyDataOp } from '@core/team/testing/legacyFold26';
import { c, HOUR, MIN, T0 } from '@core/team/testing/fixtures';
import { forAll, int, mulberry32, pick } from '@core/team/testing/prop';
import { crew, why } from '@core/teamdraw/testUtils';
import { teamPins } from '@core/teamui/pins';
import { teamRegistry, teamPlugin } from './index';
import {
  cleanNoteText,
  displayNoteText,
  fadeOf,
  hasSeen,
  MAX_LIVE_NOTES_PER_AUTHOR,
  MAX_NOTE_CHARS,
  MAX_NOTE_LIFE_MS,
  MAX_NOTE_LINES,
  noteBody,
  noteEditBody,
  noteExpiry,
  noteFadeForDrawing,
  noteLength,
  noteMeta,
  PNM,
  PNR,
  prepareNoteText,
  seenBody,
  validNoteText,
} from './notes';

const ch = (...cps: number[]) => String.fromCodePoint(...cps);
const RLO = ch(0x202e);
const LRI = ch(0x2066);
const PDI = ch(0x2069);
const ZWJ = ch(0x200d);
const ZWSP = ch(0x200b);
const BOM = ch(0xfeff);
const LSEP = ch(0x2028);
const NBSP = ch(0xa0);
const ACUTE = ch(0x301);
const TAG_A = ch(0xe0041);
const LONE = String.fromCharCode(0xd800);
const MAN = ch(0x1f468);
const GIRL = ch(0x1f467);

describe('R-NOTE-1 sanitiser', () => {
  const table: [string, string, string][] = [
    [
      'plain text stays',
      'Hut water is dry. Fill up at the lake.',
      'Hut water is dry. Fill up at the lake.',
    ],
    ['bidi override dropped', `abc${RLO}gpj.exe`, 'abcgpj.exe'],
    ['bidi isolates dropped', `${LRI}left${PDI} right`, 'left right'],
    ['zero-width space and BOM dropped', `a${ZWSP}b${BOM}c`, 'abc'],
    ['ZWJ chains broken apart', `${MAN}${ZWJ}${GIRL}`, `${MAN}${GIRL}`],
    ['tag characters dropped', `flag${TAG_A}${TAG_A}`, 'flag'],
    ['C0 / C1 controls dropped', `bell${ch(7)}del${ch(0x7f)}c1${ch(0x85)}`, 'belldelc1'],
    ['lone surrogate dropped', `x${LONE}y`, 'xy'],
    ['CRLF, CR and line separator are line breaks', `a\r\nb\rc${LSEP}d`, 'a\nb\nc\nd'],
    ['tabs and NBSP fold to one space', `a\t\tb${NBSP}${NBSP}c`, 'a b c'],
    ['lines trimmed, blank runs collapsed', '  a  \n\n\n\n b \n\n', 'a\n\nb'],
    ['prototype names are just text', '__proto__ constructor', '__proto__ constructor'],
    ['only invisible: empty', `${ZWSP}${RLO}  \n ${BOM}`, ''],
  ];
  it.each(table)('%s', (_name, raw, want) => {
    expect(cleanNoteText(raw)).toBe(want);
  });

  it(`keeps at most ${MAX_NOTE_LINES} lines, the rest joins the last`, () => {
    const out = cleanNoteText(Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n'));
    expect(out.split('\n')).toHaveLength(MAX_NOTE_LINES);
    expect(out.split('\n')[MAX_NOTE_LINES - 1]).toBe('l5 l6 l7 l8 l9 l10 l11');
  });

  it(`10 000 emoji: ${MAX_NOTE_CHARS} code points, no surrogate split`, () => {
    const out = cleanNoteText(MAN.repeat(10_000));
    expect(noteLength(out)).toBe(MAX_NOTE_CHARS);
    expect(out).toBe(MAN.repeat(MAX_NOTE_CHARS));
  });

  it('caps stacked combining marks (zalgo) at three', () => {
    expect(cleanNoteText(`a${ACUTE.repeat(40)}b`)).toBe(`a${ACUTE.repeat(3)}b`);
  });

  it('is idempotent, and its output is what the fold accepts (seeded, 500 cases)', () => {
    const alphabet = [
      'a',
      ' ',
      '\n',
      '\r',
      '\t',
      RLO,
      ZWJ,
      ZWSP,
      BOM,
      NBSP,
      ACUTE,
      MAN,
      LONE,
      TAG_A,
      'é',
      LSEP,
      ch(0),
    ];
    forAll(
      706,
      500,
      (rnd) => Array.from({ length: int(rnd, 0, 400) }, () => pick(rnd, alphabet)).join(''),
      (raw) => {
        const once = cleanNoteText(raw);
        expect(cleanNoteText(once)).toBe(once);
        expect(noteLength(once)).toBeLessThanOrEqual(MAX_NOTE_CHARS);
        expect(once.split('\n').length).toBeLessThanOrEqual(MAX_NOTE_LINES);
        if (once !== '') expect(validNoteText(once)).toBe(true);
      },
    );
  });

  it('writers compose to NFC; the fold refuses anything not clean', () => {
    expect(prepareNoteText(`Cafe${ACUTE}`)).toBe(`Caf${ch(0xe9)}`);
    expect(validNoteText(`x${RLO}`)).toBe(false);
    expect(validNoteText(' padded')).toBe(false);
    expect(validNoteText('')).toBe(false);
    expect(validNoteText(42)).toBe(false);
    expect(validNoteText('x'.repeat(MAX_NOTE_CHARS + 1))).toBe(false);
  });

  it('displays any pin text clipped with an ellipsis', () => {
    const shown = displayNoteText(`${RLO}${'w'.repeat(4000)}`);
    expect(noteLength(shown)).toBe(MAX_NOTE_CHARS);
    expect(shown.endsWith('…')).toBe(true);
    expect(displayNoteText('short')).toBe('short');
  });
});

describe('fade choices', () => {
  it('maps presets to absolute expiries; trip end is the team end', () => {
    expect(noteExpiry('1h', T0, T0 + 9 * HOUR)).toBe(T0 + HOUR);
    expect(noteExpiry('4h', T0, T0 + 9 * HOUR)).toBe(T0 + 4 * HOUR);
    expect(noteExpiry('1d', T0, T0 + 9 * HOUR)).toBe(T0 + 24 * HOUR);
    expect(noteExpiry('trip', T0, T0 + 9 * HOUR)).toBe(T0 + 9 * HOUR);
    expect(noteExpiry('trip', T0, T0 - 1)).toBeNull();
    expect(noteExpiry('trip', T0, T0 + 10 * MAX_NOTE_LIFE_MS)).toBe(T0 + MAX_NOTE_LIFE_MS);
  });
  it("takes a Text-tool note's fade from the drawing style", () => {
    expect(noteFadeForDrawing(30_000)).toBe('1h');
    expect(noteFadeForDrawing(HOUR)).toBe('1h');
    expect(noteFadeForDrawing(4 * HOUR)).toBe('4h');
    expect(noteFadeForDrawing(null)).toBe('trip');
  });
  it('reads an expiry back as the nearest preset', () => {
    expect(fadeOf(T0 + HOUR, T0)).toBe('1h');
    expect(fadeOf(T0 + 4 * HOUR, T0)).toBe('4h');
    expect(fadeOf(T0 + 24 * HOUR, T0)).toBe('1d');
    expect(fadeOf(T0 + 9 * 24 * HOUR, T0)).toBe('trip');
  });
});

/** `r`'s pin `id` at Québec City, written at `now`. */
const pin = (r: TeamReplica, now: number, id: string, tx = 'Bridge out') =>
  r.write(now, 'msg', { id, th: `pin:${r.id}:${id}`, tx, ll: [-71.2, 46.8] })!;
const set = (r: TeamReplica, now: number, body: Json) => r.write(now, 'e.set', body)!;

describe('pnm / pnr in the fold', () => {
  const at = T0 + 10 * MIN;

  it('registers both kinds, owned, on the team plug-in', () => {
    expect(teamRegistry().forKind(PNM)).toBe(teamPlugin);
    expect(teamRegistry().forKind(PNR)).toBe(teamPlugin);
    expect(teamPlugin.owned(PNM)).toBe(true);
    expect(teamPlugin.owned(PNR)).toBe(true);
    expect(teamPlugin.lane!(PNM, {})).toBe(1);
    expect(teamPlugin.lane!(PNR, {})).toBe(2);
  });

  it("dresses the author's pin as a note, then edits, moves and fades it", () => {
    const { rb } = crew();
    pin(rb, at, 'p1', 'Hut water is dry');
    set(rb, at + 1, noteBody('p1', { col: 1, fx: at + 4 * HOUR }));
    const [p] = teamPins(rb.data());
    expect(p?.note).toMatchObject({ text: 'Hut water is dry', color: 1, expiresAt: at + 4 * HOUR });
    expect(p?.note?.edited).toBe(false);
    set(rb, at + 2, noteEditBody('p1', { tx: 'Dry. Use the lake.', ll: [-71.3, 46.9], col: 3 }));
    const [q] = teamPins(rb.data());
    expect(q).toMatchObject({ lng: -71.3, lat: 46.9 });
    expect(q?.note).toMatchObject({ text: 'Dry. Use the lake.', color: 3, edited: true });
    const fx = set(rb, at + HOUR, noteEditBody('p1', { fx: at + 2 * HOUR }));
    expect(noteMeta(rb.data(), rb.id, 'p1')).toMatchObject({
      expiresAt: at + 2 * HOUR,
      fadeFrom: fx.stamp.wall,
    });
  });

  it('refuses a note on no pin, on someone else’s pin, or with bad fields', () => {
    const { rb, re } = crew();
    pin(rb, at, 'p1');
    expect(why(rb, set(rb, at + 1, noteBody('nope', { col: 1, fx: at + HOUR })).id)).toBe(
      'forbidden',
    );
    // Eve cannot dress Bob's pin: her record would name a pin of hers that does not exist.
    re.ingest(
      [...rb.log.logged()].map((o) => o.env),
      at + 1,
    );
    expect(why(re, set(re, at + 2, noteBody('p1', { col: 1, fx: at + HOUR })).id)).toBe(
      'forbidden',
    );
    const bad: [string, Record<string, Json>][] = [
      ['no colour on the first write', { show: 1, fx: at + HOUR }],
      ['colour out of the palette', { show: 1, col: 8, fx: at + HOUR }],
      ['expiry in the past', { show: 1, col: 1, fx: at - 1 }],
      ['expiry past the cap', { show: 1, col: 1, fx: at + MAX_NOTE_LIFE_MS + 2 * MIN }],
      ['dirty text', { show: 1, col: 1, fx: at + HOUR, tx: `evil${RLO}` }],
      ['bad anchor', { show: 1, col: 1, fx: at + HOUR, ll: [200, 0] }],
      ['bad flag', { show: 2, col: 1, fx: at + HOUR }],
    ];
    for (const [name, f] of bad) {
      const op = set(rb, at + 3, { k: PNM, id: 'p1', f });
      expect([name, why(rb, op.id)]).toEqual([name, 'invalid']);
    }
    // A set naming another owner is malformed (only a delete names one).
    expect(why(rb, set(rb, at + 4, { k: PNM, id: 'p1', o: re.id, f: { show: 1 } }).id)).toBe(
      'invalid',
    );
    // A field a later version adds is accepted (forward-lenient).
    const ok = set(rb, at + 5, { k: PNM, id: 'p1', f: { show: 1, col: 1, fx: at + HOUR, zz: 1 } });
    expect(why(rb, ok.id)).toBeUndefined();
  });

  it('guests write notes on their own pins', () => {
    const { rg } = crew();
    pin(rg, at, 'g1', 'Guest note');
    expect(why(rg, set(rg, at + 1, noteBody('g1', { col: 2, fx: at + HOUR })).id)).toBeUndefined();
    expect(teamPins(rg.data())[0]?.note?.text).toBe('Guest note');
  });

  it(`caps live notes per author at ${MAX_LIVE_NOTES_PER_AUTHOR}; expired ones free a slot`, () => {
    const { rb } = crew();
    let now = at;
    for (let i = 0; i < MAX_LIVE_NOTES_PER_AUTHOR; i++) {
      pin(rb, (now += 1), `n${i}`);
      const op = set(
        rb,
        (now += 1),
        noteBody(`n${i}`, { col: 0, fx: at + (i === 0 ? MIN : HOUR) }),
      );
      expect(why(rb, op.id)).toBeUndefined();
    }
    pin(rb, (now += 1), 'extra');
    expect(why(rb, set(rb, (now += 1), noteBody('extra', { col: 0, fx: at + HOUR })).id)).toBe(
      'forbidden',
    );
    // Editing a live one is never capped.
    expect(why(rb, set(rb, (now += 1), noteEditBody('n5', { col: 2 })).id)).toBeUndefined();
    // Once n0 has faded, there is room again.
    now = at + 2 * MIN;
    expect(why(rb, set(rb, now, noteBody('extra', { col: 0, fx: at + HOUR })).id)).toBeUndefined();
  });

  it('deleting the pin removes the note; author or admin only', () => {
    const { w, rb, re, sync } = crew();
    pin(rb, at, 'p1');
    set(rb, at + 1, noteBody('p1', { col: 1, fx: at + HOUR }));
    pin(rb, at + 2, 'p2');
    set(rb, at + 3, noteBody('p2', { col: 1, fx: at + HOUR }));
    sync(at + 4);
    const eveDel = re.write(at + 5, 'e.del', { k: 'msg', id: 'p1', o: rb.id })!;
    expect(why(re, eveDel.id)).toBe('forbidden');
    rb.write(at + 6, 'e.del', { k: 'msg', id: 'p1' });
    w.root.write(at + 7, 'e.del', { k: 'msg', id: 'p2', o: rb.id });
    sync(at + 8);
    expect(teamPins(rb.data())).toEqual([]);
  });

  it('a "seen" receipt per reader, never for my own note, only for a pin that exists', () => {
    const { rb, re, rg, sync } = crew();
    pin(rb, at, 'p1');
    set(rb, at + 1, noteBody('p1', { col: 1, fx: at + HOUR }));
    sync(at + 2);
    expect(why(re, set(re, at + 3, seenBody(rb.id, 'p1', at + 3)).id)).toBeUndefined();
    expect(why(rg, set(rg, at + 3, seenBody(rb.id, 'p1', at + 3)).id)).toBeUndefined();
    expect(why(rb, set(rb, at + 3, seenBody(rb.id, 'p1', at + 3)).id)).toBe('invalid');
    expect(why(re, set(re, at + 4, seenBody(rb.id, 'ghost', at + 4)).id)).toBe('forbidden');
    expect(why(re, set(re, at + 4, { k: PNR, id: 'p1', f: { p: rb.id } }).id)).toBe('invalid');
    sync(at + 5);
    const data = rb.data();
    expect(hasSeen(data, re.id, rb.id, 'p1')).toBe(true);
    expect(hasSeen(data, rg.id, rb.id, 'p1')).toBe(true);
    expect(hasSeen(data, rb.id, rb.id, 'p1')).toBe(false);
  });

  it('every phone folds the same notes, whatever the order ops arrive in', () => {
    const { w, rb, re, sync } = crew();
    pin(rb, at, 'p1');
    set(rb, at + 1, noteBody('p1', { col: 1, fx: at + HOUR }));
    pin(re, at + 2, 'e1');
    set(re, at + 3, noteBody('e1', { col: 4, fx: at + HOUR }));
    sync(at + 4);
    set(re, at + 5, seenBody(rb.id, 'p1', at + 5));
    set(rb, at + 6, noteEditBody('p1', { tx: 'Edited' }));
    sync(at + 7);
    const rnd = mulberry32(7);
    const envs = [...w.root.log.logged()].map((o) => o.env);
    const fresh = new GroupReplica(c, w.teamId, w.replicas.get(re.id)!.keys);
    fresh.ingest(
      envs.sort(() => rnd() - 0.5),
      at + 8,
    );
    expect(teamPins(fresh.data())).toEqual(teamPins(rb.data()));
  });
});

// ── Mixed versions ──────────────────────────────────────────────────────────

/** The real replica with the frozen 2.6.1 data fold. */
function v26Replica(): typeof import('@core/team/replica').TeamReplica {
  let out: typeof import('@core/team/replica').TeamReplica | undefined;
  jest.isolateModules(() => {
    jest.doMock('@core/team/data', () => ({
      ...jest.requireActual<object>('@core/team/data'),
      applyDataOp: (o: TeamData, s: never, op: SignedOp, d: (op: SignedOp) => Json | undefined) =>
        legacyApplyDataOp(o, s, op, d),
    }));
    /* eslint-disable @typescript-eslint/no-require-imports */
    out = (require('@core/team/replica') as typeof import('@core/team/replica')).TeamReplica;
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return out!;
}

describe('2.6.1 ↔ 2.7 with notes', () => {
  const OldReplica = v26Replica();
  const at = T0 + 10 * MIN;

  function noted() {
    const t = crew();
    const { rb, re, sync } = t;
    const notes: SignedOp[] = [];
    pin(rb, at, 'p1', 'Bridge out, ford 50 m upstream');
    notes.push(set(rb, at + 1, noteBody('p1', { col: 4, fx: at + 4 * HOUR })));
    sync(at + 2);
    notes.push(set(re, at + 3, seenBody(rb.id, 'p1', at + 3)));
    notes.push(set(rb, at + 4, noteEditBody('p1', { tx: 'Bridge fixed' })));
    const after = rb.write(at + 5, 'msg', { id: 'm2', th: 'team', tx: 'After the note' })!;
    sync(at + 6);
    return { ...t, notes, after };
  }

  it('a 2.6.1 phone stores pnm / pnr, skips them as invalid, and shows a plain pin', () => {
    const { w, eve, notes, after } = noted();
    const old = new OldReplica(c, w.teamId, w.replicas.get(eve.id)!.keys);
    old.ingest(
      [...w.root.log.logged()].map((o) => o.env),
      at + 7,
    );
    for (const op of notes) expect(old.log.get(op.id)).toBeDefined();
    expect(old.log.get(after.id)).toBeDefined();
    expect(old.versionVector()).toEqual(w.root.versionVector());
    expect(old.parkedSize).toBe(0);
    const skipped = new Map(old.data().skipped.map((s) => [s.id, s.why]));
    for (const op of notes) expect(skipped.get(op.id)).toBe('invalid');
    const pins = teamPins(old.data());
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ id: 'p1', note: null });
    expect(pins[0]?.messages[0]?.text).toBe('Bridge out, ford 50 m upstream');
    // Everything else reads the same as on a 2.7 phone.
    const msgs = (d: TeamData) =>
      [...d.entities.values()]
        .filter((r) => r.kind === 'msg')
        .map((r) => r.id)
        .sort();
    expect(msgs(old.data())).toEqual(msgs(w.root.data()));
  });

  it('through a 2.6.1 relay, a 2.7 phone gets the note whole', () => {
    const { w, eve, gus, rg } = noted();
    const old = new OldReplica(c, w.teamId, w.replicas.get(eve.id)!.keys);
    old.ingest(
      [...w.root.log.logged()].map((o) => o.env),
      at + 7,
    );
    const fresh = new GroupReplica(c, w.teamId, w.replicas.get(gus.id)!.keys);
    fresh.ingest(
      [...old.log.logged()].map((o) => o.env),
      at + 8,
    );
    expect(teamPins(fresh.data())).toEqual(teamPins(rg.data()));
    expect(teamPins(fresh.data())[0]?.note?.text).toBe('Bridge fixed');
  });
});
