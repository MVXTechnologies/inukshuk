import type { ClockEstimate } from './clock';
import {
  addButtonLabel,
  BY_TIME_TEXT,
  groupCheck,
  toggleGroup,
  byGpsText,
  clockRows,
  deviceDateFormat,
  importOutcomeMessage,
  outsideText,
  selectedTitle,
  sheetSubtitle,
  thumbStrip,
  thumbsPerRow,
  type DateFormat,
} from './importSheet';
import type { ImportPlan, PlannedPhoto } from './placement';

const fmt: DateFormat = {
  day: (ms) => `D${ms}`,
  time: (ms) => `T${ms}`,
};
const pos = { distanceM: 10, lngLat: [0, 0] as [number, number] };

const gps = (key: string, offTrackM: number, camera?: string): PlannedPhoto => ({
  candidate: { key, ...(camera ? { camera } : {}) },
  result: { kind: 'gps', position: pos, offTrackM },
  clockOffsetMs: 0,
});
const outside = (
  key: string,
  reason: 'time' | 'far' | 'no-data',
  takenAt?: number,
): PlannedPhoto => ({
  candidate: { key, ...(takenAt === undefined ? {} : { takenAt }) },
  result: { kind: 'outside', reason },
  clockOffsetMs: 0,
});
const timed = (key: string, camera?: string): PlannedPhoto => ({
  candidate: { key, takenAt: 1, ...(camera ? { camera } : {}) },
  result: { kind: 'time', position: pos, takenAt: 1 },
  clockOffsetMs: 0,
});

const est = (status: ClockEstimate['status'], samples: number, offsetMs = 0): ClockEstimate => ({
  status,
  samples,
  offsetMs,
});

describe('titles', () => {
  it('counts the pick', () => {
    expect(selectedTitle(35)).toBe('35 photos selected');
    expect(selectedTitle(1)).toBe('1 photo selected');
  });

  it('says what the photos were matched against', () => {
    expect(sheetSubtitle({ startMs: 1, endMs: 2 }, 0, fmt)).toBe(
      'Matched against your recording · D1, T1 – T2',
    );
    expect(sheetSubtitle({}, 3, fmt)).toBe(
      'This route has no times: photos go where their location says · 3 already on this trail',
    );
  });

  it('formats real dates on the device', () => {
    expect(deviceDateFormat.day(Date.UTC(2026, 8, 27, 15))).toMatch(/27/);
    expect(deviceDateFormat.time(Date.UTC(2026, 8, 27, 15))).toMatch(/\d/);
  });

  it('labels the add button', () => {
    expect(addButtonLabel(0)).toBe('Add photos');
    expect(addButtonLabel(1)).toBe('Add 1 photo');
    expect(addButtonLabel(33)).toBe('Add 33 photos');
  });
});

describe('group texts', () => {
  it('explains the time group', () => {
    expect(BY_TIME_TEXT).toMatch(/where you were at that minute/);
  });

  it('explains the location group with the distance from the trail', () => {
    expect(byGpsText([gps('a', 9.2)], true)).toBe(
      'No time in the file. Placed at its GPS position, 9 m from the trail.',
    );
    expect(byGpsText([gps('a', 9), gps('b', 41.6)], true)).toBe(
      'No time in the file. Placed at their GPS position, all within 42 m of the trail.',
    );
    expect(byGpsText([gps('a', 3)], false)).toBe(
      'Placed on the route by its GPS position, 3 m from the trail.',
    );
    expect(byGpsText([], true)).toBe('No time in the file. Placed at their GPS position.');
  });

  it('explains the outsiders with their times', () => {
    expect(outsideText([outside('a', 'far', 10), outside('b', 'time', 5)], fmt)).toBe(
      'Taken D5 at T5 and D10 at T10, far from the trail. Left out unless you tick them.',
    );
    expect(outsideText([outside('a', 'time', 7)], fmt)).toBe(
      'Taken D7 at T7, outside this outing. Left out unless you tick it.',
    );
    expect(
      outsideText([outside('a', 'time', 3), outside('b', 'time', 1), outside('c', 'time', 2)], fmt),
    ).toBe(
      'Taken between D1 at T1 and D3 at T3, outside this outing. Left out unless you tick them.',
    );
    expect(outsideText([outside('a', 'no-data'), outside('b', 'no-data')], fmt)).toBe(
      '2 photos have no time or location. Left out unless you tick them.',
    );
    expect(outsideText([outside('a', 'no-data')], fmt)).toBe(
      '1 photo has no time or location. Left out unless you tick it.',
    );
  });

  it('shows six thumbnails at most, the last one a "+N"', () => {
    expect(thumbStrip([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(thumbStrip([1, 2, 3, 4, 5, 6, 7, 8], 6)).toEqual({ shown: [1, 2, 3, 4, 5], more: 3 });
  });

  it('fits as many thumbnails as one row holds', () => {
    // 5 × 52 + 4 × 6 = 284
    expect(thumbsPerRow(284, 52, 6)).toBe(5);
    expect(thumbsPerRow(283, 52, 6)).toBe(4);
    expect(thumbsPerRow(40, 52, 6)).toBe(2);
  });
});

describe('clockRows', () => {
  const plan = (
    clock: ClockEstimate,
    cameras: [string, ClockEstimate][],
    photos: PlannedPhoto[],
  ): Pick<ImportPlan, 'clock' | 'cameraClocks' | 'byTime' | 'byGps' | 'outside'> => ({
    clock,
    cameraClocks: new Map(cameras),
    byTime: photos,
    byGps: [],
    outside: [],
  });

  it('is one unnamed row for one camera', () => {
    expect(
      clockRows(plan(est('ok', 30), [['Pixel 8', est('ok', 30)]], [timed('a', 'Pixel 8')]), false),
    ).toEqual([
      {
        key: 'camera:Pixel 8',
        title: 'Camera clock matches your GPS',
        detail: 'Checked on 30 photos that have a location · off by under 1 min',
      },
    ]);
  });

  it('is one row per camera, plus the photos without a camera', () => {
    const rows = clockRows(
      plan(
        est('ok', 12),
        [
          ['Canon EOS R6', est('corrected', 4, 3_600_000)],
          ['Pixel 8', est('unknown', 1)],
        ],
        [timed('a', 'Canon EOS R6'), timed('b', 'Pixel 8'), timed('c')],
      ),
      false,
    );
    expect(rows).toEqual([
      {
        key: 'camera:Canon EOS R6',
        title: 'Camera clock is 1 h behind',
        detail: 'Canon EOS R6 · Checked on 4 photos that have a location · corrected',
      },
      {
        key: 'camera:Pixel 8',
        title: 'Camera clock matches your GPS',
        detail: "Pixel 8 · Too few photos with a location · uses the other photos' check",
      },
      {
        key: 'batch',
        title: 'Camera clock matches your GPS',
        detail: 'Other photos · Checked on 12 photos that have a location · off by under 1 min',
      },
    ]);
  });

  it('says when nothing could be checked', () => {
    expect(clockRows(plan(est('unknown', 0), [], [timed('a')]), false)).toEqual([
      {
        key: 'batch',
        title: 'Camera clock not checked',
        detail: 'No photo has both a time and a location, so their times are used as they are',
      },
    ]);
    // Several cameras, none checkable (Android's picker drops locations): still one row.
    expect(
      clockRows(
        plan(
          est('unknown', 0),
          [
            ['Canon EOS R6', est('unknown', 0)],
            ['Pixel 8', est('unknown', 0)],
          ],
          [timed('a', 'Canon EOS R6'), timed('b', 'Pixel 8'), timed('c')],
        ),
        false,
      ),
    ).toHaveLength(1);
    expect(clockRows(plan(est('unknown', 2), [], [timed('a')]), false)[0]!.detail).toBe(
      'Checked on 2 photos that have a location · too few to check, times used as they are',
    );
    expect(clockRows(plan(est('unknown', 1), [], [timed('a')]), false)[0]!.detail).toMatch(
      /^Checked on 1 photo that has a location/,
    );
  });

  it('is a single "set by hand" row after Adjust', () => {
    expect(clockRows(plan(est('corrected', 5, -120_000), [], []), true)).toEqual([
      { key: 'manual', title: 'Camera clock is 2 min ahead', detail: 'Set by hand with Adjust' },
    ]);
  });
});

describe('importOutcomeMessage', () => {
  it('words every outcome', () => {
    expect(importOutcomeMessage({ added: 33, failed: 0, chosen: 33 })).toBe('Added 33 photos');
    expect(importOutcomeMessage({ added: 30, failed: 3, chosen: 33 })).toBe(
      'Added 30 of 33 photos · 3 could not be read',
    );
    expect(importOutcomeMessage({ added: 30, failed: 0, chosen: 33 })).toBe(
      'Added 30 of 33 photos',
    );
    expect(
      importOutcomeMessage({ added: 12, failed: 0, chosen: 33, stopped: 'storage-full' }),
    ).toBe('Stopped: storage is full · added 12 photos');
    expect(importOutcomeMessage({ added: 0, failed: 0, chosen: 33, stopped: 'cancelled' })).toBe(
      'Cancelled · no photos added',
    );
    expect(importOutcomeMessage({ added: 0, failed: 2, chosen: 2 })).toBe(
      'No photos added: 2 photos could not be read',
    );
    expect(importOutcomeMessage({ added: 0, failed: 0, chosen: 0 })).toBe('No photos added');
  });
});

describe('group checkboxes', () => {
  it('reads and toggles a group', () => {
    const keys = ['a', 'b'];
    expect(groupCheck(keys, new Set())).toBe('unchecked');
    expect(groupCheck(keys, new Set(['a']))).toBe('mixed');
    expect(groupCheck(keys, new Set(['a', 'b', 'z']))).toBe('checked');
    expect(groupCheck([], new Set(['a']))).toBe('unchecked');
    expect([...toggleGroup(new Set(['a', 'z']), keys)].sort()).toEqual(['a', 'b', 'z']);
    expect([...toggleGroup(new Set(['a', 'b', 'z']), keys)]).toEqual(['z']);
  });
});
