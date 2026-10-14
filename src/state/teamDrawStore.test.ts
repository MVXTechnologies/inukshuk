/**
 * The drawing style survives the first "Draw on map" of a launch (2.5.2
 * review): entering read nothing yet, counted the hint from zero and wrote
 * `prefs: null` over the remembered style.
 */
import type { StoredDraw } from '@data/teamDrawPrefs';
import { useWaypointClusterSheet } from '@features/map/waypoints/waypointTap';
import { enterDrawing } from '@features/team/draw/TeamDrawMode';

import { HINT_ENTRIES, useTeamDrawStore } from './teamDrawStore';

const mockSaved: StoredDraw[] = [];
let mockFile: StoredDraw = {};
let mockRelease: (() => void) | null = null;
jest.mock('@data/teamDrawPrefs', () => ({
  loadTeamDraw: () =>
    new Promise<StoredDraw>((resolve) => {
      mockRelease = () => resolve(mockFile);
    }),
  saveTeamDraw: (v: StoredDraw) => {
    mockSaved.push(v);
  },
}));
// TeamDrawMode's module graph (only `enterDrawing` is used here).
jest.mock('@maplibre/maplibre-react-native', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const STYLE = { colour: 4, width: 3, dashed: true, fadeMs: 600_000 };

/** A new launch: nothing read yet, nothing written yet. */
function launch(file: StoredDraw): void {
  mockSaved.length = 0;
  mockFile = file;
  mockRelease = null;
  useTeamDrawStore.setState({
    hydrated: false,
    rawPrefs: null,
    tool: 'free',
    hints: 0,
    active: false,
    hintNow: false,
  });
}

async function enter(): Promise<void> {
  const p = enterDrawing();
  // The read is still pending: nothing is entered or written yet.
  expect(useTeamDrawStore.getState().active).toBe(false);
  expect(mockSaved).toEqual([]);
  mockRelease?.();
  await p;
}

describe('entering drawing mode on a fresh launch', () => {
  it('keeps the saved style: the first write carries it, never prefs null', async () => {
    launch({ prefs: STYLE, tool: 'arrow', hints: 1 });
    await enter();
    const s = useTeamDrawStore.getState();
    expect(s.active).toBe(true);
    expect(s.rawPrefs).toEqual(STYLE);
    expect(s.tool).toBe('arrow');
    expect(mockSaved).toEqual([{ prefs: STYLE, tool: 'arrow', hints: 2 }]);
  });

  it('shows the hint on the first three entries across launches, then never', async () => {
    const seen: boolean[] = [];
    let file: StoredDraw = {};
    for (let i = 0; i < 5; i++) {
      launch(file);
      await enter();
      seen.push(useTeamDrawStore.getState().hintNow);
      useTeamDrawStore.getState().exit();
      file = mockSaved[mockSaved.length - 1] ?? file;
      if (i === 0) expect(file).toEqual({ prefs: null, tool: 'free', hints: 1 });
    }
    expect(seen).toEqual([true, true, true, false, false]);
    expect(file.hints).toBe(HINT_ENTRIES);
  });

  it('a tool picked before the file was read is written once, merged with the saved style', async () => {
    launch({ prefs: STYLE, tool: 'free', hints: 3 });
    const read = useTeamDrawStore.getState().hydrate();
    useTeamDrawStore.getState().setTool('rect');
    expect(mockSaved).toEqual([]);
    mockRelease?.();
    await read;
    expect(mockSaved).toEqual([{ prefs: STYLE, tool: 'rect', hints: 3 }]);
  });

  it('closes the waypoint cluster list (it does not survive into drawing mode)', async () => {
    launch({});
    useWaypointClusterSheet.getState().open(['saved-a', 'saved-b']);
    await enter();
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
  });
});
