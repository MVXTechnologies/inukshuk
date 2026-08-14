import type { MapDocument, TrackSummary, Waypoint } from '@core/models';
import {
  UNGROUPED_FOLDER_ID,
  nextFolderVisibility,
  visibleMaps,
  visibleTrackIds,
  visibleWaypoints,
} from './visibility';

const map = (id: string, folderId?: string) => ({ id, folderId }) as MapDocument;
const track = (id: string, folderId?: string) => ({ id, folderId }) as TrackSummary;
const wp = (id: string, folderId?: string) => ({ id, folderId }) as Waypoint;

const maps = [map('m1', 'f1'), map('m2'), map('m3', 'f2')];
const tracks = [track('t1', 'f1'), track('t2'), track('t3', 'f2')];
const wps = [wp('w1', 'f1'), wp('w2')];

describe('type mode', () => {
  it('shows all maps and waypoints; trails follow activeTrackIds', () => {
    expect(visibleMaps('type', [], maps)).toHaveLength(3);
    expect(visibleWaypoints('type', [], wps)).toHaveLength(2);
    expect(visibleTrackIds('type', ['f1'], tracks, ['t2'])).toEqual(['t2']);
  });
});

describe('folders mode', () => {
  it('shows exactly the checked folders’ items', () => {
    expect(visibleMaps('folders', ['f1'], maps).map((m) => m.id)).toEqual(['m1']);
    expect(visibleTrackIds('folders', ['f2'], tracks, ['t2'])).toEqual(['t3']);
    expect(visibleWaypoints('folders', ['f1'], wps).map((w) => w.id)).toEqual(['w1']);
  });

  it('the ungrouped pseudo-id selects folderless items', () => {
    expect(visibleMaps('folders', [UNGROUPED_FOLDER_ID], maps).map((m) => m.id)).toEqual(['m2']);
    expect(visibleTrackIds('folders', [UNGROUPED_FOLDER_ID, 'f1'], tracks, [])).toEqual([
      't1',
      't2',
    ]);
    expect(visibleWaypoints('folders', [UNGROUPED_FOLDER_ID], wps).map((w) => w.id)).toEqual([
      'w2',
    ]);
  });

  it('an empty selection shows nothing', () => {
    expect(visibleMaps('folders', [], maps)).toEqual([]);
    expect(visibleTrackIds('folders', [], tracks, ['t1'])).toEqual([]);
    expect(visibleWaypoints('folders', [], wps)).toEqual([]);
  });
});

describe('nextFolderVisibility', () => {
  it('entering folder mode selects exactly the tapped folder', () => {
    expect(nextFolderVisibility({ mode: 'type', visibleFolderIds: [] }, 'f1')).toEqual({
      mode: 'folders',
      visibleFolderIds: ['f1'],
    });
  });

  it('a stale selection left over from type mode never survives as a toggle-off', () => {
    // The blank-map bug: 'f1' is still in the persisted set while "Everything"
    // is on, so a toggle would have removed it and shown nothing.
    expect(nextFolderVisibility({ mode: 'type', visibleFolderIds: ['f1', 'f2'] }, 'f1')).toEqual({
      mode: 'folders',
      visibleFolderIds: ['f1'],
    });
  });

  it('adds and removes within folder mode', () => {
    expect(nextFolderVisibility({ mode: 'folders', visibleFolderIds: ['f1'] }, 'f2')).toEqual({
      mode: 'folders',
      visibleFolderIds: ['f1', 'f2'],
    });
    expect(nextFolderVisibility({ mode: 'folders', visibleFolderIds: ['f1', 'f2'] }, 'f1')).toEqual(
      { mode: 'folders', visibleFolderIds: ['f2'] },
    );
  });

  it('never yields an empty selection when a folder is being turned on', () => {
    const cases: readonly FolderVisibilityCase[] = [
      { mode: 'type', visibleFolderIds: [] },
      { mode: 'type', visibleFolderIds: ['f1'] },
      { mode: 'type', visibleFolderIds: [UNGROUPED_FOLDER_ID] },
      { mode: 'folders', visibleFolderIds: [] },
      { mode: 'folders', visibleFolderIds: ['f2'] },
    ];
    for (const c of cases) {
      const next = nextFolderVisibility(c, 'f1');
      expect(next.mode).toBe('folders');
      expect(next.visibleFolderIds).toContain('f1');
    }
  });
});

type FolderVisibilityCase = Parameters<typeof nextFolderVisibility>[0];
