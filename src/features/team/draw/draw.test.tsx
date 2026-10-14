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
import { DRAW_LAYERS } from '@core/teamdraw/mapStyle';
import { penBody, toleranceM, type Stroke } from '@core/teamdraw/pen';
import { defaultPrefs, penStyle } from '@core/teamdraw/style';
import { NEAR, QC } from '@core/teamdraw/testUtils';
import { resetAppTeamServiceForTests } from '@data/team/appTeam';
import { LoopbackMeshHub } from '@data/team/loopbackMesh';
import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite } from '@data/team/teamSession';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamDrawStore } from '@state/teamDrawStore';
import { useTeamStore, wireTeamStore } from '@state/teamStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert, BackHandler } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { TeamFab } from '../map/TeamCards';
import { useTeamMapFocus } from '../map/teamMapFocus';
import { DrawAlertSnack } from './DrawAlertSnack';
import { TeamShapeCard } from './ShapeCard';
import { drawLayerStats, TeamDrawLayers } from './TeamDrawLayers';
import { TeamDrawingsRow } from './TeamDrawingsRow';
import { TeamDrawMode } from './TeamDrawMode';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];
jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => {
    mockSources.push(props);
    return props.children ?? null;
  },
  Images: () => null,
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
  notifyTeam: (n: unknown) => mockNotify(n),
  onTeamNotificationTap: () => () => undefined,
}));
jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
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
  });

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

const touch = (id: number, x: number, y: number) => ({ identifier: id, pageX: x, pageY: y });
const ev = (...touches: ReturnType<typeof touch>[]) => ({ nativeEvent: { touches } });

let app: TeamService;

beforeEach(async () => {
  mockLayers.length = 0;
  mockSources.length = 0;
  mockPush.mockReset();
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    extensions: { ...d, team: { ...d.team, installedAt: Date.now() } },
    units: 'metric',
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
  await act(() => useTeamStore.getState().refresh());
});

afterEach(async () => {
  await app.active?.stopMesh();
});

const style = penStyle({ ...defaultPrefs(0), fadeMs: 30_000 });
const arrow = (id: string): Stroke => ({ id, sh: 'arrow', pts: [QC, NEAR], style });

describe('the team menu', () => {
  it('has “Draw on map” right after Rally, which opens drawing mode', async () => {
    await render(wrap(<TeamFab bottom={72} />));
    await fireEvent.press(screen.getByTestId('team-fab'));
    const ids = screen
      .queryAllByTestId(/^team-fab-/)
      .map((n) => n.props.testID as string)
      .filter((id, k, all) => all.indexOf(id) === k && id !== 'team-fab-scrim');
    expect(ids.indexOf('team-fab-draw')).toBe(ids.indexOf('team-fab-rally') + 1);
    await fireEvent.press(screen.getByTestId('team-fab-draw'));
    expect(useTeamDrawStore.getState().active).toBe(true);
  });

  it('hides it for guests', async () => {
    const view = useTeamStore.getState().view!;
    useTeamStore.setState({
      view: { ...view, members: view.members.map((m) => ({ ...m, role: 'guest' as const })) },
    });
    await render(wrap(<TeamFab bottom={72} />));
    await fireEvent.press(screen.getByTestId('team-fab'));
    expect(screen.queryByTestId('team-fab-draw')).toBeNull();
    expect(screen.queryByTestId('team-fab-rally')).toBeNull();
  });
});

describe('drawing mode', () => {
  async function open(dark = false, hit: string | null = null) {
    const m = mapDouble(hit);
    useTeamDrawStore.getState().enter();
    const r = await render(
      wrap(
        <TeamDrawMode mapRef={m.mapRef as never} cameraRef={m.cameraRef as never} focused />,
        dark,
      ),
    );
    const canvas = screen.getByTestId('team-draw-canvas');
    await fireEvent(canvas, 'layout', { nativeEvent: { layout: { width: 400, height: 800 } } });
    await act(async () => undefined);
    return { ...m, r, canvas };
  }

  it('shows its bars in both themes, the tools at ≥ 52 dp, and nothing when closed', async () => {
    const closed = await render(
      wrap(<TeamDrawMode mapRef={{ current: null }} cameraRef={{ current: null }} focused />),
    );
    expect(screen.queryByTestId('team-draw-mode')).toBeNull();
    await closed.unmount();
    for (const dark of [false, true]) {
      const { r } = await open(dark);
      expect(screen.getByTestId('team-draw-done')).toBeTruthy();
      expect(screen.getByTestId('team-draw-clear')).toBeTruthy();
      for (const k of ['free', 'arrow', 'circle', 'rect']) {
        const flat = Object.assign(
          {},
          ...[screen.getByTestId(`team-draw-tool-${k}`).props.style].flat(3),
        );
        expect(flat.width).toBeGreaterThanOrEqual(52);
        expect(flat.height).toBeGreaterThanOrEqual(52);
      }
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
    await fireEvent.press(screen.getByTestId('team-draw-tool-circle'));
    expect(useTeamDrawStore.getState().tool).toBe('circle');
    expect(screen.getByTestId('team-draw-tool-circle').props.accessibilityState.selected).toBe(
      true,
    );
    await fireEvent.press(screen.getByTestId('team-draw-done'));
    expect(useTeamDrawStore.getState().active).toBe(false);
    expect(useTeamDrawStore.getState().tool).toBe('circle');
    // Android Back = Done (the style closes first when it is open).
    const handlers: (() => boolean)[] = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
      handlers.push(h as () => boolean);
      return { remove: () => undefined };
    });
    await open();
    await fireEvent.press(screen.getByTestId('team-draw-style-button'));
    await act(async () => {
      handlers[handlers.length - 1]!();
    });
    expect(screen.queryByTestId('team-draw-style')).toBeNull();
    expect(useTeamDrawStore.getState().active).toBe(true);
    await act(async () => {
      handlers[handlers.length - 1]!();
    });
    expect(useTeamDrawStore.getState().active).toBe(false);
  });

  it('remembers the style (30 s by default; no red)', async () => {
    await open();
    await fireEvent.press(screen.getByTestId('team-draw-style-button'));
    expect(screen.getByTestId('team-draw-style')).toBeTruthy();
    // 10 s · 30 s · 1 min · 5 min · 30 min · 4 h · Never: 30 s is on.
    expect(screen.getByTestId('team-draw-fade-1').props.accessibilityState.selected).toBe(true);
    expect(screen.queryByTestId('team-draw-colour-8')).toBeNull();
    await fireEvent.press(screen.getByTestId('team-draw-fade-6'));
    await fireEvent.press(screen.getByTestId('team-draw-colour-3'));
    await fireEvent.press(screen.getByTestId('team-draw-dash-1'));
    expect(useTeamDrawStore.getState().rawPrefs).toMatchObject({
      fadeMs: null,
      colour: 3,
      dashed: true,
    });
    await fireEvent.press(screen.getByTestId('team-draw-style-close'));
    expect(screen.queryByTestId('team-draw-style')).toBeNull();
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
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      const { canvas, r } = await open(dark, key);
      await fireEvent(canvas, 'responderGrant', ev(touch(1, 200, 400)));
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      jest.useRealTimers();
      await until(() => useTeamDrawStore.getState().menu === key, 'menu');
      await fireEvent(canvas, 'responderRelease', ev());
      expect(screen.getByTestId('team-draw-menu-left').props.children).toMatch(
        /^Fades in [45] min/,
      );
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

  it('is not there for members', async () => {
    const view = useTeamStore.getState().view!;
    useTeamStore.setState({ view: { ...view, isAdmin: false } });
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
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
      await act(async () => {
        await new Promise((r) => setTimeout(r, 250));
      });
    }
    await until(() => useTeamDrawStore.getState().live[0]?.pts.length === 9, 'all 8 updates');
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
