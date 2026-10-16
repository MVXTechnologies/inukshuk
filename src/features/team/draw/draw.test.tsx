import { METRIC } from '@core/format';
/**
 * Team drawing's screens (#683) against a real `TeamService` on the loopback
 * mesh (Node crypto, memory disk): the team menu's entry, drawing mode (its
 * bars, the hint, the style, the gestures, Clear mine), a shape's menu and
 * card, Manage team › Drawings, the "is drawing" snackbar, the map layers,
 * and the render budget (a teammate drawing four times a second re-renders
 * the drawing layer only). Light and dark.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { LIVE_LAYER_ORDER, liveLayerAnchor, type LiveLayerId } from '@core/map/liveLayerOrder';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';
import type { TeamView } from '@core/teamui/view';
import { FRAME_MS } from '@core/teamdraw/fade';
import { DRAW_FADING_LAYERS, DRAW_FADING_SOURCE, DRAW_LAYERS } from '@core/teamdraw/mapStyle';
import * as penModule from '@core/teamdraw/pen';
import { PEN_INTERVAL_MS, penBody, toleranceM, type Stroke } from '@core/teamdraw/pen';
import { defaultPrefs, penStyle } from '@core/teamdraw/style';
import { NEAR, QC } from '@core/teamdraw/testUtils';
import { resetAppTeamServiceForTests } from '@data/team/appTeam';
import { LoopbackMeshHub } from '@data/team/loopbackMesh';
import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite } from '@data/team/teamSession';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamDrawStore } from '@state/teamDrawStore';
import { settleTeamStoreForTests, useTeamStore, wireTeamStore } from '@state/teamStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState, type ReactNode } from 'react';
import { Alert, BackHandler, StyleSheet, View } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { TeamPanel } from '../bar/TeamPanel';
import { TeamStatusBar } from '../bar/TeamStatusBar';
import { useTeamMapFocus } from '../map/teamMapFocus';
import { DrawAlertSnack } from './DrawAlertSnack';
import { TeamShapeCard } from './ShapeCard';
import { ShapeMenu } from './ShapeMenu';
import { drawLayerStats, TeamDrawLayers } from './TeamDrawLayers';
import { TeamDrawingsRow } from './TeamDrawingsRow';
import { BOTTOM_LAYER } from '../../map/bottomLayers';
import { TeamDrawMode } from './TeamDrawMode';
import { BASE_MAP_IMAGES } from '../../map/MapImages';
import { DRAW_IMAGES } from './drawImages';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];
const mockImages: Props[] = [];
jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => {
    mockSources.push(props);
    return props.children ?? null;
  },
  Images: (props: Props) => {
    mockImages.push(props);
    return null;
  },
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@data/storage', () => ({
  newId: () => 'new-id',
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
  deleteFileAt: jest.fn(),
}));
const mockNotify = jest.fn(async (_n: unknown) => undefined);
jest.mock('@data/team/teamNotifications', () => ({
  buzzRally: () => undefined,
  notifyTeam: (n: unknown) => mockNotify(n),
  onTeamNotificationTap: () => () => undefined,
  dismissTeamNotification: async () => undefined,
  setInAppAlarm: () => undefined,
  armSos: () => undefined,
  silenceSos: () => undefined,
  SOS_TONE_MS: 8_000,
}));
jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
/** Renders of the drawing components (each reads the scheme tokens once per render). */
const mockTokenReads = { n: 0 };
jest.mock('@ui/useSchemeTokens', () => {
  const actual = jest.requireActual<typeof import('@ui/useSchemeTokens')>('@ui/useSchemeTokens');
  return {
    ...actual,
    useSchemeTokens: () => {
      mockTokenReads.n++;
      return actual.useSchemeTokens();
    },
  };
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const wrap = (children: ReactNode, dark = false) => (
  <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>
);

const hub = new LoopbackMeshHub();
const phone = () =>
  new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: hub.createTransport(),
    tickMs: 0,
    // The injected clock reads Date.now at each call, so a test on jest's fake
    // clock moves the replica's time too (the default binds the real one).
    now: () => Date.now(),
  });

/**
 * Jest's clock until {@link realClock} (afterEach calls it too): timers,
 * animation frames and Date.now move together, and only when the test
 * advances them. The promise queues stay real, so the team service's async
 * work still settles.
 */
let faked = false;
function fakeClock(): void {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  faked = true;
}
/**
 * Back to the real clock. Pending fake timers run first: a timer or frame
 * scheduled on jest's clock never fires on the real one, and the team store's
 * once-per-frame guards (module state) would then wait forever in later tests.
 */
async function realClock(): Promise<void> {
  if (!faked) return;
  await act(async () => {
    jest.runOnlyPendingTimers();
    settleTeamStoreForTests();
  });
  jest.useRealTimers();
  faked = false;
}

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 1600 && !cond(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  if (!cond()) throw new Error(`timed out: ${what}`);
}

/** The map and camera the mode drives. */
function mapDouble(hit: string | null = null) {
  const jumps: unknown[] = [];
  const mapRef = {
    current: {
      getViewState: jest.fn(async () => ({
        center: QC,
        zoom: 15,
        bearing: 0,
        pitch: 0,
        bounds: [0, 0, 0, 0],
      })),
      queryRenderedFeatures: jest.fn(async () =>
        hit === null ? [] : [{ properties: { drw: hit } }],
      ),
    },
  };
  const cameraRef = {
    current: { jumpTo: jest.fn((o: unknown) => jumps.push(o)), easeTo: jest.fn() },
  };
  return { mapRef, cameraRef, jumps };
}

/** A touch at (x, y) in the overlay's dp; `statusBar` is how far the window's origin sits above it. */
const touch = (id: number, x: number, y: number, statusBar = 0) => ({
  identifier: id,
  locationX: x,
  locationY: y,
  pageX: x,
  pageY: y + statusBar,
});
const ev = (...touches: ReturnType<typeof touch>[]) => ({ nativeEvent: { touches } });

let app: TeamService;

/**
 * Show the screens another view of the team by stubbing the session the store
 * snapshots, never the store: beforeEach's createTeam leaves the store's
 * 250 ms throttled refresh pending, and on a loaded machine it fired after a
 * value written into the store and put the real view back (#726).
 */
async function stubView(patch: (v: TeamView) => TeamView): Promise<void> {
  const session = app.active!;
  const real = session.view.bind(session);
  jest.spyOn(session, 'view').mockImplementation(() => patch(real()));
  await act(() => useTeamStore.getState().refresh());
}

beforeEach(async () => {
  mockLayers.length = 0;
  mockSources.length = 0;
  mockImages.length = 0;
  mockPush.mockReset();
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    extensions: { ...d, team: { ...d.team, installedAt: Date.now() } },
    units: METRIC,
  });
  useTeamDrawStore.setState({
    active: false,
    hintNow: false,
    hints: 0,
    tool: 'free',
    rawPrefs: null,
    live: [],
    selected: null,
    menu: null,
    card: null,
    announced: null,
    hydrated: true,
  });
  app = phone();
  resetAppTeamServiceForTests(app);
  wireTeamStore();
  await app.createTeam({ name: 'Ridge crew', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
  // From a settled store: createTeam's throttled refresh runs now. Left on the
  // wall clock, it fired mid-test on a loaded machine, inside tests that run on
  // jest's clock too, and re-read drawings that test said had expired (#726).
  await act(async () => settleTeamStoreForTests());
  await act(() => useTeamStore.getState().refresh());
});

afterEach(async () => {
  await realClock();
  await app.active?.stopMesh();
  settleTeamStoreForTests();
});

const style = penStyle({ ...defaultPrefs(0), fadeMs: 30_000 });
const arrow = (id: string): Stroke => ({ id, sh: 'arrow', pts: [QC, NEAR], style });

describe('Draw, the chip under the team pill (#757)', () => {
  it('opens drawing mode; the panel no longer repeats it', async () => {
    await render(wrap(<TeamStatusBar top={8} here={null} onNavigate={jest.fn()} />));
    await fireEvent.press(screen.getByTestId('team-chip-draw'));
    await until(() => useTeamDrawStore.getState().active, 'drawing mode');
    await render(wrap(<TeamPanel top={0} here={null} />));
    expect(screen.queryByTestId('team-panel-draw')).toBeNull();
  });

  it('hides Draw and Meet here for guests', async () => {
    await stubView((v) => ({
      ...v,
      members: v.members.map((m) => ({ ...m, role: 'guest' as const })),
    }));
    await render(wrap(<TeamStatusBar top={8} here={null} onNavigate={jest.fn()} />));
    expect(screen.getByTestId('team-chip-chat')).toBeTruthy();
    expect(screen.queryByTestId('team-chip-draw')).toBeNull();
    expect(screen.queryByTestId('team-chip-rally')).toBeNull();
    await render(wrap(<TeamPanel top={0} here={null} />));
    expect(screen.queryByTestId('team-panel-rally-point')).toBeNull();
  });
});

describe('drawing mode', () => {
  async function open(
    dark = false,
    hit: string | null = null,
    extra: Partial<Parameters<typeof TeamDrawMode>[0]> = {},
  ) {
    const m = mapDouble(hit);
    useTeamDrawStore.getState().enter();
    const r = await render(
      wrap(
        <TeamDrawMode
          mapRef={m.mapRef as never}
          cameraRef={m.cameraRef as never}
          focused
          {...extra}
        />,
        dark,
      ),
    );
    const canvas = screen.getByTestId('team-draw-canvas');
    await fireEvent(screen.getByTestId('team-draw-mode'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 800 } },
    });
    await act(async () => undefined);
    return { ...m, r, canvas };
  }

  it('shows its bars in both themes: five labelled tools, one row, and nothing when closed', async () => {
    const closed = await render(
      wrap(<TeamDrawMode mapRef={{ current: null }} cameraRef={{ current: null }} focused />),
    );
    expect(screen.queryByTestId('team-draw-mode')).toBeNull();
    await closed.unmount();
    for (const dark of [false, true]) {
      const { r } = await open(dark);
      expect(screen.getByTestId('team-draw-done')).toBeTruthy();
      expect(screen.getByTestId('team-draw-clear')).toBeTruthy();
      // #756: Freehand · Arrow · Shape · Time · Undo, equal shares of one row, each labelled.
      const ids = [
        'team-draw-tool-free',
        'team-draw-tool-arrow',
        'team-draw-tool-shape',
        'team-draw-time',
        'team-draw-undo',
      ];
      const bar = StyleSheet.flatten(screen.getByTestId('team-draw-toolbar').props.style);
      expect(bar.flexDirection).toBe('row');
      expect(bar.flexWrap).toBeUndefined();
      expect(bar).toMatchObject({ left: 6, right: 6 });
      const labels: string[] = [];
      for (const id of ids) {
        const flat = StyleSheet.flatten(screen.getByTestId(id).props.style);
        expect(flat).toMatchObject({ flex: 1, minWidth: 0 });
        expect(flat.minHeight).toBeGreaterThanOrEqual(48);
        const label = screen.getByTestId(`${id}-label`);
        // One line, never cut: grows with the font up to the owner's 1.2× cap.
        expect(label.props.numberOfLines).toBe(1);
        expect(label.props.maxFontSizeMultiplier).toBe(1.2);
        expect(label.props.adjustsFontSizeToFit).toBeUndefined();
        labels.push(String(label.props.children));
      }
      expect(labels).toEqual(['Freehand', 'Arrow', 'Shape', 'Time', 'Undo']);
      // No Style button any more: its options live in each tool's panel.
      expect(screen.queryByTestId('team-draw-style-button')).toBeNull();
      // The top bar's title has the width (no pencil icon), its subtitle may wrap.
      expect(screen.getByTestId('team-draw-title')).toHaveTextContent('Drawing');
      expect(screen.getByText('Team sees it live').props.numberOfLines).toBe(2);
      expect(StyleSheet.flatten(screen.getByTestId('team-draw-top').props.style).height).toBe(
        undefined,
      );
      // Undo is dimmed (the button's own state) until something is drawn.
      expect(screen.getByTestId('team-draw-undo').props.accessibilityState.disabled).toBe(true);
      await r.unmount();
      useTeamDrawStore.getState().exit();
    }
  });

  it('shows the hint on the first three entries only', async () => {
    const seen: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const { r } = await open();
      seen.push(screen.queryByTestId('team-draw-hint') !== null);
      await r.unmount();
      useTeamDrawStore.getState().exit();
    }
    expect(seen).toEqual([true, true, true, false]);
  });

  it('keeps the tool between strokes, and Done or Back leaves', async () => {
    await open();
    // Shape opens the picker; picking a shape selects it and closes the picker.
    await fireEvent.press(screen.getByTestId('team-draw-tool-shape'));
    expect(screen.getByTestId('team-draw-panel-shape')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-draw-shape-rect'));
    expect(useTeamDrawStore.getState().tool).toBe('rect');
    expect(screen.queryByTestId('team-draw-panel')).toBeNull();
    expect(screen.getByTestId('team-draw-tool-shape').props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText('Shape, Rectangle')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-draw-tool-shape'));
    await fireEvent.press(screen.getByTestId('team-draw-shape-circle'));
    expect(useTeamDrawStore.getState().tool).toBe('circle');
    await fireEvent.press(screen.getByTestId('team-draw-done'));
    expect(useTeamDrawStore.getState().active).toBe(false);
    expect(useTeamDrawStore.getState().tool).toBe('circle');
    // Android Back = Done (an open panel closes first).
    const handlers: (() => boolean)[] = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
      handlers.push(h as () => boolean);
      return { remove: () => undefined };
    });
    await open();
    await fireEvent.press(screen.getByTestId('team-draw-time'));
    expect(screen.getByTestId('team-draw-panel')).toBeTruthy();
    await act(async () => {
      handlers[handlers.length - 1]!();
    });
    expect(screen.queryByTestId('team-draw-panel')).toBeNull();
    expect(useTeamDrawStore.getState().active).toBe(true);
    await act(async () => {
      handlers[handlers.length - 1]!();
    });
    expect(useTeamDrawStore.getState().active).toBe(false);
  });

  it('remembers the style (30 s by default; no red), each option in its own tool’s panel', async () => {
    await open();
    // Freehand is the tool: a tap on it opens its options (colour, width, line).
    await fireEvent.press(screen.getByTestId('team-draw-tool-free'));
    expect(screen.getByTestId('team-draw-panel-free')).toBeTruthy();
    expect(screen.queryByTestId('team-draw-colour-8')).toBeNull();
    // Plain words (2.5.2 QA): "Line", not "Pencil"; "your colour", never its internal name.
    expect(screen.getByText('LINE')).toBeTruthy();
    expect(screen.queryByText('PENCIL')).toBeNull();
    expect(screen.getByTestId('team-draw-own-colour')).toHaveTextContent('● your colour');
    // The sub-menu rule: no arrow heads and no fade times under Freehand.
    expect(screen.queryByTestId('team-draw-head-0')).toBeNull();
    expect(screen.queryByTestId('team-draw-fade-0')).toBeNull();
    // Centred: a full-width dock that centres a card of at most 360 dp.
    const card = StyleSheet.flatten(screen.getByTestId('team-draw-panel').props.style);
    expect(card).toMatchObject({ width: '100%', maxWidth: 360 });
    expect(card.left).toBeUndefined();
    await fireEvent.press(screen.getByTestId('team-draw-colour-3'));
    await fireEvent.press(screen.getByTestId('team-draw-dash-1'));
    // Arrow: its own head options (and the shared colour), no dash.
    await fireEvent.press(screen.getByTestId('team-draw-tool-arrow'));
    expect(screen.queryByTestId('team-draw-panel')).toBeNull();
    await fireEvent.press(screen.getByTestId('team-draw-tool-arrow'));
    expect(screen.getByTestId('team-draw-panel-arrow')).toBeTruthy();
    expect(screen.getByTestId('team-draw-head-0')).toBeTruthy();
    expect(screen.queryByTestId('team-draw-dash-0')).toBeNull();
    expect(screen.getByTestId('team-draw-colour-3').props.accessibilityState.selected).toBe(true);
    // Time: the seven choices, 30 s on, as a grid at full size.
    expect(screen.getByLabelText('Time, fades after 30 s')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-draw-time'));
    expect(screen.getByTestId('team-draw-panel-time')).toBeTruthy();
    expect(screen.getByTestId('team-draw-fade-1').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('team-draw-fade-6')).toBeTruthy();
    expect(screen.getByText('30 min').props.adjustsFontSizeToFit).toBeUndefined();
    await fireEvent.press(screen.getByTestId('team-draw-fade-6'));
    expect(useTeamDrawStore.getState().rawPrefs).toMatchObject({
      fadeMs: null,
      colour: 3,
      dashed: true,
    });
    expect(screen.getByLabelText('Time, fades after Never')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-draw-panel-close'));
    expect(screen.queryByTestId('team-draw-panel')).toBeNull();
  });

  it('one finger draws an arrow, with its readout, sent at pen-up; Undo takes it back', async () => {
    useTeamDrawStore.getState().setTool('arrow');
    const { canvas } = await open();
    await fireEvent(canvas, 'responderGrant', ev(touch(1, 200, 500)));
    await fireEvent(canvas, 'responderMove', ev(touch(1, 200, 450)));
    await fireEvent(canvas, 'responderMove', ev(touch(1, 200, 300)));
    expect(screen.getByTestId('team-draw-chip')).toBeTruthy();
    expect(screen.getByTestId('team-draw-local')).toBeTruthy();
    await fireEvent(canvas, 'responderRelease', ev());
    const mine = app.active!.draw.shapes();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ sh: 'arrow', expires: expect.any(Number) });
    expect(mine[0]!.expires! - mine[0]!.created).toBe(30_000);
    expect(screen.queryByTestId('team-draw-chip')).toBeNull();
    // The tool stays selected; Undo removes the last shape of this session.
    expect(useTeamDrawStore.getState().tool).toBe('arrow');
    await fireEvent.press(screen.getByTestId('team-draw-undo'));
    expect(app.active!.draw.shapes()).toEqual([]);
  });

  it('drops a stroke under 12 dp; a second finger cancels it and moves the map', async () => {
    const { canvas, jumps } = await open();
    await fireEvent(canvas, 'responderGrant', ev(touch(1, 100, 100)));
    await fireEvent(canvas, 'responderMove', ev(touch(1, 105, 104)));
    await fireEvent(canvas, 'responderRelease', ev());
    expect(app.active!.draw.shapes()).toEqual([]);

    await fireEvent(canvas, 'responderGrant', ev(touch(1, 100, 400)));
    await fireEvent(canvas, 'responderMove', ev(touch(1, 160, 400)));
    await fireEvent(canvas, 'responderStart', ev(touch(1, 160, 400), touch(2, 300, 400)));
    expect(screen.queryByTestId('team-draw-local')).toBeNull();
    await fireEvent(canvas, 'responderMove', ev(touch(1, 100, 400), touch(2, 360, 400)));
    expect(jumps.length).toBe(1);
    expect((jumps[0] as { zoom: number }).zoom).toBeGreaterThan(15);
    await fireEvent(canvas, 'responderEnd', ev(touch(1, 100, 400)));
    await fireEvent(canvas, 'responderRelease', ev());
    expect(app.active!.draw.shapes()).toEqual([]);
  });

  it('while recording: above the panel and its snackbars, the bar on the panel, the canvas above it', async () => {
    const PANEL = 240;
    const onCredits = jest.fn();
    for (const dark of [false, true]) {
      const { r } = await open(dark, null, { bottomInset: PANEL, onCredits });
      const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style);
      // The root stacks over the recording panel (zIndex 6) and the snackbars (8).
      expect(flat('team-draw-mode').zIndex).toBe(BOTTOM_LAYER.drawMode.zIndex);
      expect(BOTTOM_LAYER.drawMode.zIndex).toBeGreaterThan(BOTTOM_LAYER.recordingPanel.zIndex);
      expect(BOTTOM_LAYER.drawMode.zIndex).toBeGreaterThan(BOTTOM_LAYER.snackbar.zIndex);
      // The tool bar sits on the panel; the canvas stops at it (Stop and Pause stay reachable).
      expect(flat('team-draw-toolbar').bottom).toBe(PANEL + 12);
      expect(flat('team-draw-canvas').bottom).toBe(PANEL);
      // The map credits stay on the map, above the bar.
      await fireEvent.press(screen.getByTestId('map-credits-button'));
      expect(onCredits).toHaveBeenCalledWith(true);
      await r.unmount();
      useTeamDrawStore.getState().exit();
    }
    // Not recording: the bar on the safe area, the canvas full height.
    await open();
    const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style);
    expect(flat('team-draw-toolbar').bottom).toBe(12);
    expect(flat('team-draw-canvas').bottom).toBe(0);
  });

  it('the glove lock: no touch reaches drawing mode, and a stroke in progress is dropped', async () => {
    const m = mapDouble();
    useTeamDrawStore.getState().enter();
    const ui = (locked: boolean) =>
      wrap(
        <TeamDrawMode
          mapRef={m.mapRef as never}
          cameraRef={m.cameraRef as never}
          focused
          locked={locked}
        />,
      );
    const r = await render(ui(false));
    const canvas = screen.getByTestId('team-draw-canvas');
    await fireEvent(screen.getByTestId('team-draw-mode'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 800 } },
    });
    await act(async () => undefined);
    expect(screen.getByTestId('team-draw-mode').props.pointerEvents).toBe('box-none');
    await fireEvent(canvas, 'responderGrant', ev(touch(1, 100, 400)));
    await fireEvent(canvas, 'responderMove', ev(touch(1, 200, 400)));
    expect(screen.getByTestId('team-draw-local')).toBeTruthy();
    await r.rerender(ui(true));
    const root = screen.getByTestId('team-draw-mode', { includeHiddenElements: true });
    expect(root.props.pointerEvents).toBe('none');
    expect(screen.queryByTestId('team-draw-local', { includeHiddenElements: true })).toBeNull();
    await fireEvent(canvas, 'responderRelease', ev());
    expect(app.active!.draw.shapes()).toEqual([]);
  });

  it('a stroke lands under the finger whatever the status bar (edge-to-edge Android, 2.5.2 QA)', async () => {
    useTeamDrawStore.getState().setTool('arrow');
    const { canvas } = await open();
    const arrowAt = async (statusBar: number) => {
      await fireEvent(canvas, 'responderGrant', ev(touch(1, 200, 400, statusBar)));
      await act(async () => undefined);
      await fireEvent(canvas, 'responderMove', ev(touch(1, 200, 300, statusBar)));
      await fireEvent(canvas, 'responderRelease', ev());
    };
    await arrowAt(0);
    await arrowAt(52);
    const [a, b] = app.active!.draw.shapes();
    // The tail is the map point under (200, 400) in the map's dp: the centre's
    // longitude, 400 dp from the top of an 800 dp map, so the centre itself.
    expect(b!.pts).toEqual(a!.pts);
    expect(a!.pts[0]![0]).toBeCloseTo(QC[0], 9);
    expect(a!.pts[0]![1]).toBeCloseTo(QC[1], 9);
  });

  it('projects against the whole map while recording (the canvas stops at the panel)', async () => {
    useTeamDrawStore.getState().setTool('arrow');
    const { canvas } = await open(false, null, { bottomInset: 240 });
    await fireEvent(canvas, 'responderGrant', ev(touch(1, 200, 400)));
    await act(async () => undefined);
    await fireEvent(canvas, 'responderMove', ev(touch(1, 200, 300)));
    await fireEvent(canvas, 'responderRelease', ev());
    const [s] = app.active!.draw.shapes();
    expect(s!.pts[0]![1]).toBeCloseTo(QC[1], 9);
  });

  it('every stroke starts from a fresh camera read', async () => {
    useTeamDrawStore.getState().setTool('arrow');
    const { canvas, mapRef } = await open();
    const draw = async () => {
      await fireEvent(canvas, 'responderGrant', ev(touch(1, 200, 500)));
      await act(async () => undefined);
      await fireEvent(canvas, 'responderMove', ev(touch(1, 200, 300)));
      await fireEvent(canvas, 'responderRelease', ev());
    };
    const reads = mapRef.current.getViewState.mock.calls.length;
    await draw();
    expect(mapRef.current.getViewState.mock.calls.length).toBe(reads + 1);
    // The camera moved meanwhile (not by drawing mode): the next stroke lands where it shows.
    mapRef.current.getViewState.mockImplementation(async () => ({
      center: NEAR,
      zoom: 15,
      bearing: 0,
      pitch: 0,
      bounds: [0, 0, 0, 0],
    }));
    await draw();
    expect(mapRef.current.getViewState.mock.calls.length).toBe(reads + 2);
    const [a, b] = app.active!.draw.shapes();
    expect(b!.pts[0]![0] - a!.pts[0]![0]).toBeCloseTo(NEAR[0] - QC[0], 6);
    expect(b!.pts[0]![1] - a!.pts[0]![1]).toBeCloseTo(NEAR[1] - QC[1], 6);
  });

  it('a long pencil stroke builds the pen body only when the throttle lets one go', async () => {
    const { canvas } = await open();
    // One clock for the throttle and its timer: jest's (Date.now included), never the wall's.
    fakeClock();
    const built = jest.spyOn(penModule, 'penBody');
    await fireEvent(canvas, 'responderGrant', ev(touch(1, 20, 400)));
    // One act around the 120 moves: React flushes once, not after each move
    // (120 separate acts took ~1 s on a loaded machine, #726).
    await act(async () => {
      for (let i = 1; i <= 120; i++) {
        await fireEvent(canvas, 'responderMove', ev(touch(1, 20 + i * 3, 400 + (i % 5))));
      }
    });
    // 120 moves inside one throttle interval: the first real stroke went, the rest wait.
    expect(built).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(PEN_INTERVAL_MS - 1);
    });
    expect(built).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    // The interval passed: one more body, the latest stroke (all 121 points so far).
    expect(built).toHaveBeenCalledTimes(2);
    expect(built.mock.calls[1]![0].pts.length).toBe(121);
    await fireEvent(canvas, 'responderRelease', ev());
    built.mockRestore();
  });

  it('GPS fixes and heading ticks on the map screen re-render neither drawing mode nor its layer', async () => {
    const m = mapDouble();
    useTeamDrawStore.getState().enter();
    let tick: (() => void) | undefined;
    const setCredits = jest.fn();
    function MapLike() {
      // What changes per GPS fix / heading tick on MapScreen.
      const [fix, setFix] = useState(0);
      tick = () => setFix((n) => n + 1);
      return (
        <>
          <TeamDrawMode
            mapRef={m.mapRef as never}
            cameraRef={m.cameraRef as never}
            focused
            bottomInset={0}
            locked={false}
            onCredits={setCredits}
          />
          <TeamDrawLayers glyphs="https://x/fonts/{fontstack}/{range}.pbf" zoom={15} />
          <View testID={`fix-${fix}`} />
        </>
      );
    }
    await render(wrap(<MapLike />));
    await act(async () => undefined);
    expect(screen.getByTestId('team-draw-toolbar')).toBeTruthy();
    const before = mockTokenReads.n;
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) await act(async () => tick!());
    // 50 map-screen renders: not one of drawing mode, its ⓘ or its layer.
    expect(mockTokenReads.n - before).toBe(0);
  });

  it('Clear mine, with a 5 s UNDO', async () => {
    const d = app.active!.draw;
    expect(d.finish(arrow('c1'), 1, 60_000)).toBeNull();
    expect(d.finish(arrow('c2'), 1, 60_000)).toBeNull();
    await open(true);
    await fireEvent.press(screen.getByTestId('team-draw-clear'));
    expect(d.shapes()).toEqual([]);
    expect(screen.getByText('Cleared 2 drawings')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Undo'));
    expect(d.shapes()).toHaveLength(2);
  });

  it('a long-press on my shape opens its menu: time left, a 40-character note, Save, Delete', async () => {
    const d = app.active!.draw;
    expect(d.finish(arrow('m1'), 1, 5 * 60_000)).toBeNull();
    await act(() => useTeamStore.getState().refresh());
    const key = `${d.shapes()[0]!.owner}:m1`;
    for (const dark of [false, true]) {
      fakeClock();
      const { canvas, r } = await open(dark, key);
      await fireEvent(canvas, 'responderGrant', ev(touch(1, 200, 400)));
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      await realClock();
      await until(() => useTeamDrawStore.getState().menu === key, 'menu');
      await fireEvent(canvas, 'responderRelease', ev());
      expect(screen.getByTestId('team-draw-menu-left').props.children).toMatch(
        /^Fades in [45] min/,
      );
      // The arrow reaches up under the top bar: its menu sits on the tool bar instead.
      expect(
        StyleSheet.flatten(screen.getByTestId('team-draw-menu-dock').props.style),
      ).toMatchObject({ bottom: 12 + 66 + 8 });
      await fireEvent.changeText(screen.getByTestId('team-draw-note'), 'Beaver dam — cross here');
      expect(screen.getByTestId('team-draw-note-count').props.children).toBe('23 / 40');
      await fireEvent.changeText(screen.getByTestId('team-draw-note'), 'x'.repeat(60));
      expect(screen.getByTestId('team-draw-note-count').props.children).toBe('40 / 40');
      await fireEvent.changeText(screen.getByTestId('team-draw-note'), 'Beaver dam');
      await fireEvent.press(screen.getByTestId('team-draw-menu-save'));
      expect(d.shapes()[0]!.tx).toBe('Beaver dam');
      await r.unmount();
      useTeamDrawStore.getState().exit();
    }
    const { canvas } = await open(false, key);
    void canvas;
    await act(() => useTeamDrawStore.getState().openMenu(key));
    await fireEvent.press(screen.getByTestId('team-draw-menu-delete'));
    expect(d.shapes()).toEqual([]);
  });
});

describe('a shape’s menu', () => {
  it('counts its time left down while open (2.5.2 QA)', async () => {
    const d = app.active!.draw;
    expect(d.finish(arrow('t1'), 1, 5 * 60_000)).toBeNull();
    await act(() => useTeamStore.getState().refresh());
    const shape = d.shapes()[0]!;
    fakeClock();
    await render(wrap(<ShapeMenu shape={shape} place={{ top: 70 }} onClose={jest.fn()} />));
    const first = screen.getByTestId('team-draw-menu-left').props.children as string;
    await act(async () => {
      jest.advanceTimersByTime(1_150);
    });
    const later = screen.getByTestId('team-draw-menu-left').props.children as string;
    expect(later).not.toBe(first);
    expect(later).toMatch(/^Fades in 4 min 5\d s$/);
  });
});

describe('a shape’s card (outside drawing mode)', () => {
  it('shows author, kind, age, note and life, with Delete for its author', async () => {
    const d = app.active!.draw;
    expect(d.finish(arrow('k1'), 1, 30 * 60_000)).toBeNull();
    expect(d.setNote('k1', 'Go around the ridge')).toBeNull();
    await act(() => useTeamStore.getState().refresh());
    const key = d.shapes()[0]!.key;
    for (const dark of [false, true]) {
      useTeamDrawStore.getState().openCard(key);
      const nav = jest.fn();
      const r = await render(
        wrap(<TeamShapeCard here={{ latitude: QC[1], longitude: QC[0] }} onNavigate={nav} />, dark),
      );
      expect(screen.getByText('You · arrow')).toBeTruthy();
      expect(screen.getByTestId('team-shape-card-sub').props.children).toBe(
        'Drawn just now · head 1.01 km NE of you',
      );
      expect(screen.getByTestId('team-shape-card-note').props.children).toBe(
        '“Go around the ridge”',
      );
      expect(screen.getByTestId('team-shape-card-left').props.children).toMatch(/^Fades in 30 min/);
      // My own shape: no Message to myself.
      expect(screen.queryByTestId('team-shape-message')).toBeNull();
      await fireEvent.press(screen.getByTestId('team-shape-centre'));
      expect(useTeamMapFocus.getState().take()).toMatchObject({ lng: NEAR[0], lat: NEAR[1] });
      await fireEvent.press(screen.getByTestId('team-shape-navigate'));
      expect(nav).toHaveBeenCalledWith(NEAR[1], NEAR[0]);
      expect(useTeamDrawStore.getState().card).toBeNull();
      await r.unmount();
    }
    useTeamDrawStore.getState().openCard(key);
    await render(wrap(<TeamShapeCard here={null} onNavigate={jest.fn()} />));
    await fireEvent.press(screen.getByTestId('team-shape-delete'));
    expect(d.shapes()).toEqual([]);
  });

  it('answers Android Back only while the map screen is focused', async () => {
    const d = app.active!.draw;
    expect(d.finish(arrow('b1'), 1, 30 * 60_000)).toBeNull();
    await act(() => useTeamStore.getState().refresh());
    const key = d.shapes()[0]!.key;
    const handlers: (() => boolean)[] = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
      handlers.push(h as () => boolean);
      return { remove: () => handlers.splice(handlers.indexOf(h as () => boolean), 1) };
    });
    useTeamDrawStore.getState().openCard(key);
    const ui = (screenFocused: boolean) =>
      wrap(<TeamShapeCard here={null} onNavigate={jest.fn()} screenFocused={screenFocused} />);
    const r = await render(ui(false));
    // Another tab is showing: Back is that tab's, the card stays (hidden with its screen).
    expect(handlers).toHaveLength(0);
    await r.rerender(ui(true));
    expect(handlers).toHaveLength(1);
    await act(async () => {
      handlers[0]!();
    });
    expect(useTeamDrawStore.getState().card).toBeNull();
  });

  it('closes itself when its shape is gone', async () => {
    useTeamDrawStore.getState().openCard('nobody:x');
    await render(wrap(<TeamShapeCard here={null} onNavigate={jest.fn()} />));
    expect(screen.queryByTestId('team-shape-card')).toBeNull();
    expect(useTeamDrawStore.getState().card).toBeNull();
  });
});

describe('Manage team › Drawings', () => {
  it('counts the drawings and clears them all after a confirm (admins)', async () => {
    const d = app.active!.draw;
    d.finish(arrow('a1'), 1, null);
    d.finish(arrow('a2'), 1, null);
    await act(() => useTeamStore.getState().refresh());
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    for (const dark of [false, true]) {
      const r = await render(wrap(<TeamDrawingsRow />, dark));
      expect(screen.getByText('2 on the map')).toBeTruthy();
      await r.unmount();
    }
    await render(wrap(<TeamDrawingsRow />));
    await fireEvent.press(screen.getByTestId('team-drawings-clear'));
    expect(alert).toHaveBeenCalled();
    expect(d.shapes()).toEqual([]);
    expect(screen.getByText('None on the map')).toBeTruthy();
  });

  it('counts only what is still on the map: an expired drawing drops out on its own (2.5.2 QA)', async () => {
    const d = app.active!.draw;
    fakeClock();
    d.finish(arrow('k1'), 1, null);
    d.finish(arrow('s1'), 1, 400);
    await act(() => useTeamStore.getState().refresh());
    await render(wrap(<TeamDrawingsRow />));
    expect(screen.getByText('2 on the map')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(399);
    });
    expect(screen.getByText('2 on the map')).toBeTruthy();
    // No data op arrives: the store's snapshot still holds the expired one.
    await act(async () => {
      jest.advanceTimersByTime(201);
    });
    expect(useTeamStore.getState().drawings).toHaveLength(2);
    expect(screen.getByText('1 on the map')).toBeTruthy();
  });

  it('is not there for members', async () => {
    await stubView((v) => ({ ...v, isAdmin: false }));
    await render(wrap(<TeamDrawingsRow />));
    expect(screen.queryByTestId('team-drawings-row')).toBeNull();
  });
});

describe('the “is drawing” snackbar', () => {
  it('says who is drawing, frames them on SHOW, and says when they have faded', async () => {
    const d = app.active!.draw;
    d.finish(arrow('s1'), 1, null);
    await act(() => useTeamStore.getState().refresh());
    const me = useTeamStore.getState().view!.me;
    for (const dark of [false, true]) {
      const r = await render(wrap(<DrawAlertSnack />, dark));
      await act(() => useTeamDrawStore.getState().announce(me, 'Julie Tremblay'));
      expect(screen.getByText('Julie is drawing on the map')).toBeTruthy();
      await fireEvent.press(screen.getByLabelText('Show'));
      expect(screen.queryByText('Julie is drawing on the map')).toBeNull();
      expect(useTeamMapFocus.getState().take()).not.toBeNull();
      await act(() => useTeamDrawStore.getState().announce('x', 'Leo Roy', true));
      expect(screen.getByText('Leo’s drawings have faded')).toBeTruthy();
      expect(screen.queryByLabelText('Show')).toBeNull();
      await r.unmount();
    }
  });
});

describe('the map layers', () => {
  it('draws six layers at their live anchors, under the pins and teammates', async () => {
    app.active!.draw.finish(arrow('l1'), 1, null);
    await act(() => useTeamStore.getState().refresh());
    for (const dark of [false, true]) {
      mockLayers.length = 0;
      const r = await render(
        wrap(<TeamDrawLayers glyphs="https://x/fonts/{fontstack}/{range}.pbf" zoom={15} />, dark),
      );
      const ids = [...new Set(mockLayers.map((l) => l.id as string))];
      expect(ids.sort()).toEqual(Object.values(DRAW_LAYERS).sort());
      for (const l of mockLayers) {
        expect(l.beforeId).toBe(liveLayerAnchor(l.id as LiveLayerId));
        expect(LIVE_LAYER_ORDER).toContain(l.id);
      }
      await r.unmount();
    }
    // No glyph host (raster styles): no labels, the five others.
    mockLayers.length = 0;
    await render(wrap(<TeamDrawLayers glyphs={undefined} zoom={15} />));
    expect(new Set(mockLayers.map((l) => l.id)).has(DRAW_LAYERS.sym)).toBe(false);
  });

  it('leaving drawing mode leaves every map sprite in place: the layer owns none (2.5.2 QA)', async () => {
    // Pin icons and a cluster's count pill went missing after Done: an
    // <Images> that unmounts removes every name it holds from the style. The
    // drawing layer mounts and unmounts with its drawings, so it holds none;
    // its arrowheads and pills are on the map's one registration.
    for (const name of Object.keys(DRAW_IMAGES)) expect(BASE_MAP_IMAGES).toContain(name);
    const d = app.active!.draw;
    d.finish(arrow('g1'), 1, null);
    await act(() => useTeamStore.getState().refresh());
    useTeamDrawStore.getState().enter();
    const r = await render(
      wrap(<TeamDrawLayers glyphs="https://x/fonts/{fontstack}/{range}.pbf" zoom={15} />),
    );
    expect(mockSources.length).toBeGreaterThan(0);
    // Done, and the drawing cleared: the layer goes, nothing else may.
    await act(async () => {
      useTeamDrawStore.getState().exit();
      d.clearMine();
      useTeamStore.getState().refresh();
    });
    await r.unmount();
    expect(mockImages).toEqual([]);
  });

  it('a fading shape moves to its own source and fades per frame; the steady ones are not re-sent (#756)', async () => {
    fakeClock();
    const d = app.active!.draw;
    d.finish(arrow('f1'), 1, null); // steady: never fades
    d.finish(arrow('f2'), 1, 10_000); // fades over its last 5 s
    await act(() => useTeamStore.getState().refresh());
    await render(
      wrap(<TeamDrawLayers glyphs="https://x/fonts/{fontstack}/{range}.pbf" zoom={15} />),
    );
    const fadingSource = () =>
      [...mockSources].reverse().find((p) => p.id === DRAW_FADING_SOURCE) as
        { data: { features: { properties: { op: number; drw: string } }[] } } | undefined;
    // Outside the window: both on the steady source, no fading one.
    expect(fadingSource()).toBeUndefined();
    await act(async () => {
      jest.advanceTimersByTime(5_200);
    });
    // Inside it: f2 alone on the fading source, under its own six layers.
    const ids = new Set(mockLayers.map((l) => l.id as string));
    for (const id of Object.values(DRAW_FADING_LAYERS)) expect(ids.has(id)).toBe(true);
    const f2 = fadingSource()!.data.features;
    expect(f2.length).toBeGreaterThan(0);
    expect(f2.every((f) => f.properties.drw.endsWith(':f2'))).toBe(true);
    // One second of fading: many small redraws of the fading source, none of the steady one.
    const builds0 = drawLayerStats.builds;
    const fading0 = drawLayerStats.fadingBuilds;
    const ops: number[] = [];
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        jest.advanceTimersByTime(FRAME_MS + 1);
      });
      const op = fadingSource()!.data.features[0]!.properties.op;
      if (ops[ops.length - 1] !== op) ops.push(op);
    }
    expect(drawLayerStats.builds - builds0).toBe(0);
    // Measured: one rebuild per 0.01 step (~10 in this second near the window's start).
    expect(drawLayerStats.fadingBuilds - fading0).toBeGreaterThanOrEqual(5);
    expect(drawLayerStats.fadingBuilds - fading0).toBeLessThanOrEqual(31);
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i - 1]! - ops[i]!).toBeGreaterThan(0);
      expect(ops[i - 1]! - ops[i]!).toBeLessThanOrEqual(0.0101);
    }
    await realClock();
  });

  it('draws nothing without drawings or with the team extension hidden', async () => {
    await render(wrap(<TeamDrawLayers glyphs={undefined} zoom={null} />));
    expect(mockSources).toHaveLength(0);
  });
});

describe('the render budget', () => {
  it('a teammate drawing 4/s re-renders the drawing layer only, never the team store (the map)', async () => {
    // Julie founds and draws; this phone (Marc) is the app.
    const julie = phone();
    const session = await julie.createTeam({
      name: 'T',
      myName: 'Julie',
      lifetimeMs: lifetimeMs('14d'),
    });
    await session.startMesh();
    const inv = session.createInvite(DEFAULT_INVITE) as CreatedInvite;
    const marc = phone();
    resetAppTeamServiceForTests(marc);
    wireTeamStore();
    await marc.startJoin(inv.token, 'Marc');
    await until(() => marc.join?.state().phase === 'verify', 'admitted');
    await marc.confirmJoin();
    await marc.active!.startMesh();
    await until(
      () => session.replica.canReceive(marc.active!.me, 'pen'),
      'Marc advertises live drawing',
    );
    await act(() => useTeamStore.getState().refresh());

    let storeRenders = 0;
    function MapLike() {
      // Everything MapScreen and its team hooks read from the team store.
      useTeamStore((s) => s);
      storeRenders++;
      return null;
    }
    await render(
      wrap(
        <>
          <MapLike />
          <TeamDrawLayers glyphs="https://x/fonts/{fontstack}/{range}.pbf" zoom={15} />
        </>,
      ),
    );
    // From a settled store: the join's debounced refresh runs now, not after a sleep.
    await act(async () => settleTeamStoreForTests());
    const store0 = storeRenders;
    const builds0 = drawLayerStats.builds;
    const tol = toleranceM(16, QC[1]);
    for (let n = 2; n <= 9; n++) {
      const s: Stroke = {
        id: 'live1',
        sh: 'free',
        pts: Array.from({ length: n }, (_, i) => [QC[0] + i * 0.0005, QC[1] + (i % 2) * 0.0003]),
        style,
      };
      session.draw.sendPen(penBody(s, tol)!);
      // Each update lands before the next goes (a pen's 250 ms pace, without the clock).
      await until(() => useTeamDrawStore.getState().live[0]?.pts.length === n, `update ${n}`);
    }
    // Two seconds of drawing: the layer rebuilt per update (merged per frame), the map never.
    expect(storeRenders).toBe(store0);
    expect(drawLayerStats.builds - builds0).toBeGreaterThanOrEqual(4);
    expect(drawLayerStats.builds - builds0).toBeLessThanOrEqual(9);
    // Julie's first stroke of the session: the snackbar, once.
    expect(useTeamDrawStore.getState().announced).toMatchObject({ name: 'Julie', faded: false });
    expect(useTeamDrawStore.getState().announced!.seq).toBe(1);
    // A shape that lives 30 min also notifies (Julie is the admin: an alert, with sound).
    const head: Stroke = { id: 'n30', sh: 'arrow', pts: [QC, NEAR], style };
    expect(session.draw.finish(head, tol, 30 * 60_000)).toBeNull();
    await until(() => mockNotify.mock.calls.length === 1, 'notification');
    expect(mockNotify.mock.calls[0]![0]).toMatchObject({
      title: 'Julie drew on the map',
      body: 'An arrow · fades in 30 min',
      url: `/team/draw/${session.me}`,
      quiet: false,
    });
    await session.stopMesh();
    await marc.active?.stopMesh();
  }, 30_000);
});
