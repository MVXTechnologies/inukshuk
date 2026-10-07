import { gzipSync, strToU8, zipSync, type Zippable } from 'fflate';

import { memoryArchiveHost, walkActivityArchive } from './archive';
import type { DecodedActivity } from './decode';
import { ByteBudget } from './limits';
import { GPX, TCX, fitBytes } from './testFixtures';

async function walk(
  zip: Uint8Array,
  limits: Parameters<typeof walkActivityArchive>[3] = {},
): Promise<{
  activities: DecodedActivity[];
  failed: number;
  limitReached: boolean;
  spillsLeft: number;
}> {
  const host = memoryArchiveHost(new Map([['root', zip]]));
  const activities: DecodedActivity[] = [];
  const res = await walkActivityArchive('root', host, (a) => void activities.push(a), limits);
  return { activities, ...res, spillsLeft: host.spills.size };
}

const STRAVA_CSV = [
  'Activity ID,Activity Date,Activity Name,Activity Type,Filename',
  '1,x,Lunch Run,Trail Run,activities/1.fit.gz',
  '2,x,Evening Ride,Ride,activities/2.gpx',
].join('\n');

describe('walkActivityArchive', () => {
  it('charges a caller-supplied budget (shared with a later photo pass, #587)', async () => {
    const budget = new ByteBudget(Number.MAX_SAFE_INTEGER);
    const zip = zipSync({ 'activities/2.gpx': strToU8(GPX) });
    await walk(zip, { budget });
    expect(budget.used).toBe(strToU8(GPX).length);
  });

  it('imports a Strava bulk export, naming from activities.csv', async () => {
    const zip = zipSync({
      'activities.csv': strToU8(STRAVA_CSV),
      'activities/1.fit.gz': [gzipSync(fitBytes(1)), { level: 0 }],
      'activities/2.gpx': strToU8(GPX),
      'activities/3.tcx.gz': gzipSync(strToU8(TCX)),
      'activities/4.fit': strToU8('corrupt'),
      'media/photo.jpg': new Uint8Array([0xff, 0xd8]),
      'profile.json': strToU8('{}'),
      '__MACOSX/activities/._1.fit.gz': strToU8('junk'),
    });
    const progress = jest.fn();
    const errors = jest.fn();
    const host = memoryArchiveHost(new Map([['root', zip]]));
    const activities: DecodedActivity[] = [];
    const res = await walkActivityArchive('root', host, (a) => void activities.push(a), {
      onProgress: progress,
      onEntryError: errors,
    });
    expect(res).toEqual({ failed: 1, limitReached: false });
    expect(errors).toHaveBeenCalledWith(expect.any(Error), 'activities/4.fit');
    expect(activities.map((a) => [a.sourceName, a.name, a.sport])).toEqual([
      ['activities/1.fit.gz', 'Lunch Run', 'trail_running'],
      ['activities/2.gpx', 'Evening Ride', 'cycling'],
      ['activities/3.tcx.gz', undefined, 'cycling'],
    ]);
    expect(progress).toHaveBeenLastCalledWith({ processed: 4, discovered: 4 });
  });

  it('recurses into Garmin nested zips and cleans up spills', async () => {
    const inner = zipSync({
      'a.fit': fitBytes(17),
      'b.fit': fitBytes(2),
      'notes.txt': strToU8(''),
    });
    const outer = zipSync({
      'DI_CONNECT/DI-Connect-Fitness/user.json': strToU8('{}'),
      'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip': [inner, { level: 0 }],
    });
    const { activities, failed, spillsLeft } = await walk(outer);
    expect(activities.map((a) => a.sport)).toEqual(['hiking', 'cycling']);
    expect(failed).toBe(0);
    expect(spillsLeft).toBe(0);
  });

  it('counts a corrupt nested zip as one failure', async () => {
    const outer = zipSync({ 'x.zip': strToU8('not a zip'), 'ok.fit': fitBytes() });
    const { activities, failed } = await walk(outer);
    expect(activities).toHaveLength(1);
    expect(failed).toBe(1);
  });

  it('caps nesting depth', async () => {
    let z = zipSync({ 'deep.fit': fitBytes() });
    for (let i = 0; i < 3; i++) z = zipSync({ [`level${i}.zip`]: z } as Zippable);
    expect((await walk(z)).activities).toHaveLength(1);
    const capped = await walk(z, { limits: { maxDepth: 2 } });
    expect(capped.activities).toHaveLength(0);
    expect(capped.failed).toBe(1);
  });

  it('skips files over the per-entry cap by their declared or actual size', async () => {
    const zip = zipSync({ 'big.fit': fitBytes(), 'bomb.fit.gz': gzipSync(new Uint8Array(5000)) });
    const res = await walk(zip, { limits: { maxEntryBytes: 40 } });
    expect(res.activities).toHaveLength(0);
    expect(res.failed).toBe(2);
    expect(res.limitReached).toBe(false);
  });

  it('caps nested archive size', async () => {
    const inner = zipSync({ 'a.fit': fitBytes() });
    const outer = zipSync({ 'in.zip': inner });
    const declared = await walk(outer, { limits: { maxNestedArchiveBytes: 10 } });
    expect(declared.failed).toBe(1);
    expect(declared.spillsLeft).toBe(0);
  });

  it('stops the walk once the total budget is spent', async () => {
    const zip = zipSync({ 'a.fit': fitBytes(), 'b.fit': fitBytes(), 'c.fit': fitBytes() });
    const one = fitBytes().length;
    const res = await walk(zip, { limits: { maxTotalBytes: one + 10 } });
    expect(res.activities).toHaveLength(1);
    expect(res.limitReached).toBe(true);
    expect(res.failed).toBe(1);
  });

  it('stops at the entry cap', async () => {
    const zip = zipSync({ 'a.fit': fitBytes(), 'b.fit': fitBytes(), 'c.fit': fitBytes() });
    const res = await walk(zip, { limits: { maxEntries: 2 } });
    expect(res.activities).toHaveLength(2);
    expect(res.limitReached).toBe(true);
  });

  it('propagates an unreadable top-level archive and a missing ref', async () => {
    await expect(walk(strToU8('nope'))).rejects.toThrow(/ZIP/);
    const host = memoryArchiveHost(new Map());
    await expect(walkActivityArchive('missing', host, () => {})).rejects.toThrow(/no such/);
  });

  it('imports without names when activities.csv is unreadable', async () => {
    const csv = strToU8(STRAVA_CSV.replace('activities/1.fit.gz', 'a.fit').repeat(20));
    const zip = zipSync({ 'activities.csv': csv, 'a.fit': fitBytes(1) });
    const res = await walk(zip, { limits: { maxEntryBytes: fitBytes().length } });
    expect(res.activities.map((a) => a.name)).toEqual([undefined]);
    expect(res.failed).toBe(0);
  });
});
