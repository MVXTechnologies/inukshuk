/** TEST-ONLY helpers for the team-drawing tests (#683). */
import type { Json } from '@core/team/canonical';
import type { SignedOp } from '@core/team/envelope';
import type { TeamReplica } from '@core/team/replica';
import {
  addMember,
  device,
  exchange,
  joinReplica,
  newWorld,
  T0,
} from '@core/team/testing/fixtures';
import { encodePolyline } from '@core/trails/polyline';

import type { Pt } from './geo';
import { stampWall } from './pen';

/** Québec City, Plains of Abraham. */
export const QC: Pt = [-71.2167, 46.8025];
export const NEAR: Pt = [-71.2067, 46.8085];

/** Owner (admin), Bob and Eve (members), Gus (guest), all synced. */
export function crew() {
  const w = newWorld();
  const bob = device();
  const eve = device();
  const gus = device();
  addMember(w.root, bob, 'member', T0 + 1);
  addMember(w.root, eve, 'member', T0 + 2);
  addMember(w.root, gus, 'guest', T0 + 3);
  const rb = joinReplica(w, bob, w.root, T0 + 4);
  const re = joinReplica(w, eve, w.root, T0 + 4);
  const rg = joinReplica(w, gus, w.root, T0 + 4);
  const all = [w.root, rb, re, rg];
  const sync = (now: number) => {
    for (const r of all) exchange(w.root, r, now);
    for (const r of all) exchange(w.root, r, now);
  };
  return { w, bob, eve, gus, rb, re, rg, all, sync };
}

/** A valid arrow's fields at `wall`, living `life` ms (null = never). */
export function arrowFields(
  wall: number,
  life: number | null = 30_000,
  over: Record<string, Json> = {},
): Record<string, Json> {
  return {
    sh: 'arrow',
    g: encodePolyline([QC, NEAR]),
    c: 1,
    w: 2,
    d: false,
    ht: 'fill',
    hs: 2,
    x: life === null ? null : wall + life,
    ...over,
  };
}

/** `r` draws an arrow `id` at `now` (fields computed against its own clock). */
export function drawOn(
  r: TeamReplica,
  now: number,
  id: string,
  life: number | null = 30_000,
  over: Record<string, Json> = {},
): SignedOp {
  const wall = stampWall(r.writer.cursor.hlc.wall, now);
  return r.write(now, 'e.set', { k: 'drw', id, f: arrowFields(wall, life, over) })!;
}

export const why = (r: TeamReplica, id: string) => r.data().skipped.find((s) => s.id === id)?.why;
