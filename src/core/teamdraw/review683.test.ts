/**
 * Regression tests for the security review of the team drawing protocol
 * (#683). Each block reproduces a finding with the reviewer's own scenario
 * and pins the fix. Work is counted (decodes, scans, folds), never timed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Json } from '@core/team/canonical';
import { checkEnvelope, PEN_TTL_S, type SignedOp } from '@core/team/envelope';
import { MAX_CLOCK_LEAD_MS } from '@core/team/hlc';
import type { TeamReplica } from '@core/team/replica';
import { c, HOUR, MIN, T0 } from '@core/team/testing/fixtures';
import { encodePolyline } from '@core/trails/polyline';

import { DrawAlerts } from './alerts';
import { capBody } from './caps';
import { destination } from './geo';
import { liveStrokes, penBody, toleranceM } from './pen';
import { MAX_LIVE_PER_AUTHOR } from './record';
import { crew, drawOn, QC } from './testUtils';
import { drawClock, drawViewWork, MAX_DRAWN, MAX_SHOWN_LIFE_MS, teamShapes } from './view';

const envs = (r: TeamReplica, now: number) =>
  [...r.log.logged(), ...r.liveEphemeral(now)].map((op) => op.env);

const clockOf = (r: TeamReplica, now: number) => drawClock(r.writer.cursor.hlc.wall, now);

const BATCH_GAP = 4 * HOUR + 2 * MIN;

describe('P0: future-dated stamps', () => {
  /** The reviewer's scenario: Eve's 5 shapes, then Bob's 6 batches of 30, each 4 h further ahead. */
  function flood() {
    const t0 = crew();
    const { w, rb, re, sync } = t0;
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    for (let i = 0; i < 5; i++) drawOn(re, now + i, `e${i}`, null);
    let n = 0;
    for (let b = 0; b < 6; b++) {
      for (let i = 0; i < 30; i++) drawOn(rb, now + b * BATCH_GAP + i, `b${n++}`, 4 * HOUR);
    }
    const t = now + MIN;
    re.ingest(envs(rb, t), t);
    w.root.ingest(envs(rb, t), t);
    w.root.ingest(envs(re, t), t);
    return { ...t0, now, t };
  }

  it('the fold holds 180 of Bob’s shapes, but the view shows 30, and all of Eve’s', () => {
    const { bob, eve, re, t } = flood();
    const data = re.data(t);
    const held = [...data.entities.values()].filter((e) => e.kind === 'drw' && e.owner === bob.id);
    expect(held).toHaveLength(180); // what the fold cannot judge without a clock
    const clock = clockOf(re, t);
    expect(clock).toBeLessThanOrEqual(t + MAX_CLOCK_LEAD_MS);
    drawViewWork.decodes = 0;
    const shapes = teamShapes(data, clock);
    expect(shapes.filter((s) => s.owner === bob.id)).toHaveLength(MAX_LIVE_PER_AUTHOR);
    expect(shapes.filter((s) => s.owner === eve.id)).toHaveLength(5);
    for (const s of shapes) expect(s.created).toBeLessThanOrEqual(clock + MAX_CLOCK_LEAD_MS);
    // Only shapes that made the cut were decoded.
    expect(drawViewWork.decodes).toBe(35);
  });

  it('a future shape raises no alert until it is current', () => {
    const { w, bob, t } = flood();
    const a = new DrawAlerts();
    const ahead = { kind: 'shape', author: bob.id, created: t + 4 * HOUR, expires: null } as const;
    expect(a.admit(w.root.state, ahead, w.owner.id, t)).toBeNull();
    expect(a.admit(w.root.state, ahead, w.owner.id, t + 4 * HOUR)?.snackbar).toBe(true);
  });

  it('an admin delete at real time still wins once the future shape becomes current', () => {
    const { w, bob, rb, re, t } = flood();
    w.root.write(t + 1000, 'e.del', { k: 'drw', id: 'b179', o: bob.id });
    re.ingest(envs(w.root, t + 2000), t + 2000);
    const visible = (r: TeamReplica, at: number) =>
      teamShapes(r.data(at), clockOf(r, at)).map((s) => s.id);
    expect(visible(re, t + 2000)).not.toContain('b179');
    // Move to when the last batch is current: Bob's batch shows, minus the deleted one.
    const created = re.data(t + 2000).entities.get(`drw:${bob.id}:b179`)!.state.created!.wall;
    const later = created + MIN;
    const ids = visible(re, later);
    expect(ids).toContain('b150');
    expect(ids).toContain('b178');
    expect(ids).not.toContain('b179');
    expect(ids.filter((id) => id.startsWith('b'))).toHaveLength(29);
    // Control: Bob, who never got the delete, does show it then.
    expect(visible(rb, later)).toContain('b179');
  });

  it('a shape revived with a stamp hours ahead lives at most 4 h + 1 min from its first write', () => {
    const { rb, re, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    drawOn(rb, now, 'a', 10 * MIN);
    rb.write(now + 1, 'e.del', { k: 'drw', id: 'a' });
    // The re-set is stamped 20 h ahead, its `x` 4 h after that: 24 h from now.
    drawOn(rb, now + 20 * HOUR, 'a', 4 * HOUR);
    re.ingest(envs(rb, now + MIN), now + MIN);
    const shown = (at: number) => teamShapes(re.data(at), clockOf(re, at));
    expect(shown(now + MIN)).toEqual([]); // written ahead of the clock: not yet
    expect(shown(now + 20 * HOUR + MIN)).toEqual([]); // current, but past 4 h + 1 min of life
    expect(MAX_SHOWN_LIFE_MS).toBe(4 * HOUR + MIN);
  });

  it('the 60 slots are shared round-robin: three full authors get 20 each', () => {
    const { w, rb, re, sync, bob, eve } = crew();
    sync(T0 + MIN);
    for (let i = 0; i < 30; i++) {
      drawOn(rb, T0 + 2 * MIN + i, `b${i}`, null);
      drawOn(re, T0 + 2 * MIN + i, `e${i}`, null);
      drawOn(w.root, T0 + 3 * MIN + i, `o${i}`, null);
    }
    sync(T0 + 4 * MIN);
    const shapes = teamShapes(w.root.data(), T0 + 4 * MIN);
    expect(shapes).toHaveLength(MAX_DRAWN);
    for (const who of [bob.id, eve.id, w.owner.id]) {
      expect(shapes.filter((s) => s.owner === who)).toHaveLength(20);
    }
    // Each author's newest made it; oldest first overall.
    expect(shapes.map((s) => s.id)).toEqual(expect.arrayContaining(['b29', 'e29', 'o29']));
    expect(shapes[shapes.length - 1]!.id).toBe('o29');
  });
});

describe('P1-2: expired shapes cost nothing', () => {
  const g = encodePolyline(
    Array.from({ length: 500 }, (_, k) => destination(QC, (k * 37) % 360, 10 + k * 3)),
  );
  const free = { sh: 'free', g, ht: undefined as never, hs: undefined as never };

  it('1000 expired 500-point shapes: zero geometry decodes per call', () => {
    const { rb, re, sync } = crew();
    sync(T0 + MIN);
    let now = T0 + 2 * MIN;
    for (let i = 0; i < 1000; i++) drawOn(rb, (now += 5), `x${i}`, 1, free);
    re.ingest(
      [...rb.log.logged()].map((o) => o.env),
      now,
    );
    const data = re.data(now);
    expect([...data.entities.values()].filter((e) => e.kind === 'drw')).toHaveLength(1000);
    drawViewWork.decodes = 0;
    expect(teamShapes(data, now + 1000)).toEqual([]);
    expect(drawViewWork.decodes).toBe(0);
  });

  it('geometry is decoded once per written geometry, across calls', () => {
    const { rb, re, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    for (let i = 0; i < 3; i++) drawOn(rb, now + i, `s${i}`, null, free);
    re.ingest(envs(rb, now + 10), now + 10);
    drawViewWork.decodes = 0;
    expect(teamShapes(re.data(now + 10), now + 10)).toHaveLength(3);
    expect(teamShapes(re.data(now + 20), now + 20)).toHaveLength(3);
    expect(drawViewWork.decodes).toBe(3);
    // A note leaves the geometry alone; an Undo (delete, then the same fields) re-decodes it.
    rb.write(now + 30, 'e.set', { k: 'drw', id: 's0', f: { tx: 'Here' } });
    rb.write(now + 31, 'e.del', { k: 'drw', id: 's1' });
    drawOn(rb, now + 32, 's1', null, free);
    re.ingest(envs(rb, now + 40), now + 40);
    const shapes = teamShapes(re.data(now + 40), now + 40);
    expect(shapes.find((s) => s.id === 's0')!.tx).toBe('Here');
    expect(shapes).toHaveLength(3);
    expect(drawViewWork.decodes).toBe(4);
  });
});

describe('P2-4/5: live strokes', () => {
  const style = { c: 2, w: 2 as const, d: false };
  const body = (n: number) =>
    penBody(
      {
        id: 'live',
        sh: 'free',
        pts: Array.from({ length: n + 2 }, (_, k) => destination(QC, 30 * k, 5 * k)),
        style,
      },
      toleranceM(16, QC[1]),
    )! as unknown as Json;

  /** A `pen` with any ttl, built and signed like the real one. */
  function rawPen(r: TeamReplica, now: number, ttl: number): SignedOp {
    const key = r.sendKey()!;
    return r.writer.ephemeral(now, {
      t: 'pen',
      secret: body(1),
      enc: { mode: 'group', keyId: key.keyId, key: key.key },
      ttl,
    });
  }

  it('a pen with a ttl over 30 s is malformed; 30 s is fine; pos keeps its day', () => {
    const { w, rb, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    const ctx = { teamId: w.teamId, now };
    expect(checkEnvelope(c, rawPen(rb, now, PEN_TTL_S + 1).env, ctx)).toEqual({
      ok: false,
      reason: 'shape',
    });
    expect(checkEnvelope(c, rawPen(rb, now + 1, PEN_TTL_S).env, ctx).ok).toBe(true);
    const pos = rb.position(now + 2, { la: 46.8, lo: -71.2, at: now }, 3600)!;
    expect(checkEnvelope(c, pos.env, ctx).ok).toBe(true);
  });

  it('a receiver whose clock runs 2 min ahead still sees the stroke, for 30 s after it arrives', () => {
    const { w, bob, rb, re, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    const early = rb.stroke(now - 1000, body(2))!; // never reaches Eve in time
    const op = rb.stroke(now, body(3))!;
    const ahead = now + 2 * MIN; // Eve's clock
    expect(re.ingest([op.env], ahead).accepted).toHaveLength(1);
    const read = (at: number) =>
      liveStrokes(
        re.liveEphemeral(at),
        re.state,
        (o) => re.decode(o),
        () => false,
        at,
        (o) => re.ephemeralDeadline(o),
      );
    expect(read(ahead + 29_000)).toMatchObject([{ author: bob.id, until: ahead + 30_000 }]);
    expect(re.ephemeralDeadline(op)).toBe(ahead + 30_000);
    expect(re.ephemeralDeadline(early)).toBe(now - 1000 + 30_000); // not held: its own expiry
    expect(read(ahead + 30_001)).toEqual([]);
    // Positions keep judging by their own expiry (unchanged): a 30 s pos is stale here.
    const pos = rb.position(now + 1, { la: 46.8, lo: -71.2, at: now }, 30)!;
    expect(re.ingest([pos.env], ahead).rejected).toEqual([{ reason: 'stale', id: pos.id }]);
    expect(re.ephemeralDeadline(pos)).toBe(now + 1 + 30_000);
    // Never replayed: the same stroke again after it went, or an older one.
    expect(re.ingest([op.env], ahead + 40_000).rejected).toEqual([{ reason: 'stale', id: op.id }]);
    expect(re.ingest([early.env], ahead + 40_000).rejected).toEqual([
      { reason: 'stale', id: early.id },
    ]);
    // A stroke whose own expiry is more than the tolerated lead behind is refused.
    const old = rb.stroke(now + 2, body(4))!;
    const late = now + 2 + PEN_TTL_S * 1000 + MAX_CLOCK_LEAD_MS + 1;
    expect(w.root.ingest([old.env], late).rejected).toEqual([{ reason: 'stale', id: old.id }]);
  });

  it('a stroke from far ahead is not drawn; `until` never exceeds 30 s from now', () => {
    const { w, rb, re, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    const far = rb.stroke(now + 20 * MIN, body(2))!;
    const near = re.stroke(now + 4 * MIN, body(2))!;
    w.root.ingest([far.env, near.env], now);
    const ops = w.root.liveEphemeral(now);
    expect(ops).toHaveLength(2);
    const live = liveStrokes(
      ops,
      w.root.state,
      (o) => w.root.decode(o),
      () => false,
      now,
    );
    // The far one is skipped; the near one (4 min ahead) is clamped to now + 30 s.
    expect(live.map((s) => s.author)).toEqual([re.id]);
    expect(live[0]!.until).toBe(now + 30_000);
  });
});

describe('P2-6/7: the replica on a stroke', () => {
  it('canReceive is a cached set lookup: no fold, one scan per data change', () => {
    const { w, bob, eve, rb, sync } = crew();
    rb.write(T0 + MIN, 'e.set', capBody(bob.id, T0));
    sync(T0 + 2 * MIN);
    const r = w.root;
    const flush = jest.spyOn(r, 'flush');
    const data = jest.spyOn(r, 'data');
    const folds = r.fullFolds;
    const scans = r.capScans;
    for (let i = 0; i < 500; i++) {
      expect(r.canReceive(bob.id, 'pen')).toBe(true);
      expect(r.canReceive(eve.id, 'pen')).toBe(false);
    }
    expect(flush).not.toHaveBeenCalled();
    expect(data).not.toHaveBeenCalled();
    expect(r.fullFolds).toBe(folds);
    expect(r.capScans - scans).toBeLessThanOrEqual(1);
    // Eve advertises: the next call sees it, after one more scan.
    const capOp = w.replicas.get(eve.id)!.write(T0 + 3 * MIN, 'e.set', capBody(eve.id, T0))!;
    r.ingest([capOp.env], T0 + 3 * MIN);
    const before = r.capScans;
    expect(r.canReceive(eve.id, 'pen')).toBe(true);
    expect(r.canReceive(bob.id, 'pen')).toBe(true);
    expect(r.capScans - before).toBe(1);
    flush.mockRestore();
    data.mockRestore();
  });

  it('a stroke never drops the positions view; a position does', () => {
    const { w, rb, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    const r = w.root;
    r.ingest([rb.position(now, { la: 46.8, lo: -71.2, at: now })!.env], now);
    const view = r.data(now).positions;
    const style = { c: 2, w: 2 as const, d: false };
    const pts = [QC, destination(QC, 90, 10)];
    for (let i = 0; i < 10; i++) {
      const body = penBody({ id: 's', sh: 'free', pts, style }, 1)! as unknown as Json;
      r.ingest([rb.stroke(now + 250 * (i + 1), body)!.env], now + 250 * (i + 1));
      expect(r.data(now + 250 * (i + 1)).positions).toBe(view);
    }
    r.ingest([rb.position(now + 5000, { la: 46.81, lo: -71.2, at: now })!.env], now + 5000);
    expect(r.data(now + 5000).positions).not.toBe(view);
  });
});

describe('P2-10: layering', () => {
  /** Every module `src/core/team` loads, transitively, by resolved path. */
  function closure(): Set<string> {
    const src = resolve(__dirname, '..', '..');
    const seen = new Set<string>();
    const resolveImport = (from: string, spec: string): string | null => {
      let base: string;
      if (spec.startsWith('@core/')) base = join(src, 'core', spec.slice('@core/'.length));
      else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
      else return null; // packages: checked by name below
      for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        try {
          readFileSync(cand);
          return cand;
        } catch {
          // try the next spelling
        }
      }
      throw new Error(`unresolved ${spec} from ${from}`);
    };
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
        const spec = m[1]!;
        if (/^(react|react-native|expo)(\/|$)|^@(ui|features|state|data)\//.test(spec)) {
          seen.add(`pkg:${spec}`);
          continue;
        }
        const next = resolveImport(file, spec);
        if (next !== null) visit(next);
      }
    };
    const team = join(src, 'core', 'team');
    for (const f of readdirSync(team)) {
      if (f.endsWith('.ts') && !f.endsWith('.test.ts')) visit(join(team, f));
    }
    return seen;
  }

  it('src/core/team depends on no UI module, even through team drawing', () => {
    const mods = [...closure()];
    expect(mods.some((m) => m.includes(join('core', 'teamdraw')))).toBe(true); // the scan works
    expect(mods.filter((m) => m.startsWith('pkg:') || m.includes(join('core', 'teamui')))).toEqual(
      [],
    );
  });
});
