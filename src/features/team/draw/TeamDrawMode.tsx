/**
 * Drawing mode (#683, mockups 252 frames 1–6): the team's sketch tool over
 * the main map.
 *
 * - A top bar (Clear mine, with a 5 s UNDO; Done) and a bottom tool bar
 *   (Pencil · Arrow · Circle · Rectangle | Style | Undo). The tab bar, the
 *   search, the + menu and the team button step aside; Android Back = Done.
 * - One finger draws; two fingers pan, zoom and rotate the map. The overlay
 *   takes every touch (`@core/teamdraw/gesture`) and moves the camera itself
 *   for two fingers (`@core/teamdraw/screen`): MapLibre's native gestures
 *   cannot share a touch with a view above them (see the PR's gesture spike).
 * - My stroke draws under my finger in an SVG overlay (every move, never a
 *   map source update), goes to the team about four times a second (`pen`,
 *   throttled by the core's `PenThrottle`) and becomes a shape at pen-up.
 *   Under 12 dp it is dropped; a second finger cancels it.
 * - A tap on my shape selects it; a long-press opens its menu (note, delete).
 *   An admin may do both on anyone's shape.
 */
import type { Units } from '@core/format';
import { DrawGesture, type GestureAction, type Touch } from '@core/teamdraw/gesture';
import { penBody, PenThrottle, toleranceM, type PenBody } from '@core/teamdraw/pen';
import { penStyle } from '@core/teamdraw/style';
import type { ShapeKind } from '@core/teamdraw/record';
import {
  menuSide,
  MIN_STROKE_DP,
  pinchCamera,
  screenSpan,
  startPinch,
  StrokeBuilder,
  type Pinch,
  type ScreenPt,
  type Viewport,
} from '@core/teamdraw/screen';
import { memberColor } from '@core/teamui/colors';
import { useActionSnackbar } from '@features/common/useActionSnackbar';
import { ActionSnackbar } from '@features/common/ActionSnackbar';
import { useScreenSheet } from '@features/common/useScreenSheet';
import { BOTTOM_LAYER } from '@features/map/bottomLayers';
import { MapCreditsButton } from '@features/map/components/MapCredits';
import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import { useWaypointClusterSheet } from '@features/map/waypoints/waypointTap';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamDrawStore } from '@state/teamDrawStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { drawChrome } from '@ui/teamDrawTokens';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path, Polygon } from 'react-native-svg';

import { DrawStylePopover, fadeLabel } from './DrawStylePopover';
import { useDrawPrefs, useOwnColour } from './drawShared';
import { hitTestTeamDraw } from './hitTestDraw';
import { ShapeMenu } from './ShapeMenu';

export const TOOLS: readonly { k: ShapeKind; icon: string; label: string }[] = [
  { k: 'free', icon: 'draw', label: 'Pencil' },
  { k: 'arrow', icon: 'arrow-top-right', label: 'Arrow' },
  { k: 'circle', icon: 'circle-outline', label: 'Circle' },
  { k: 'rect', icon: 'square-outline', label: 'Rectangle' },
];
const TOOL_ICON: Record<ShapeKind, string> = {
  free: 'draw',
  arrow: 'arrow-top-right',
  circle: 'circle-outline',
  rect: 'square-outline',
};
/** The hint chip's time on screen. */
export const HINT_MS = 4_000;
const LINE_DP = { 1: 3, 2: 5, 3: 8 } as const;

const clockNow = () => Date.now();

/** Is drawing mode open (MapScreen steps its chrome aside). */
export function useTeamDrawActive(): boolean {
  return useTeamDrawStore((s) => s.active);
}

/** Leave drawing mode: what was drawn stays on the map. */
export function exitDrawing(): void {
  useTeamDrawStore.getState().exit();
}

/**
 * Enter drawing mode from the team menu (members only). Once the remembered
 * style and hint count are read: entering first would count this entry from
 * zero (the hint every launch) and write the defaults over the saved style.
 */
export async function enterDrawing(): Promise<void> {
  // The waypoint cluster list does not survive into drawing mode.
  useWaypointClusterSheet.getState().close();
  const store = useTeamDrawStore.getState();
  if (!store.hydrated) await store.hydrate();
  useTeamDrawStore.getState().enter();
}

interface DrawModeProps {
  mapRef: RefObject<MapRef | null>;
  cameraRef: RefObject<CameraRef | null>;
  focused: boolean;
  /**
   * Height of what docks at the bottom edge under drawing mode (the recording
   * panel while it is up), or 0. The canvas stops above it, so it stays usable,
   * and the tool bar sits on it.
   */
  bottomInset?: number;
  /** The recording's glove lock (revamp §3): drawing mode takes no touch at all. */
  locked?: boolean;
  /** Opens the map's credits sheet (the ⓘ stays on the map: a licence requirement). */
  onCredits?: (open: true) => void;
}

/**
 * Memoised (2.5.2 review): MapScreen re-renders on every GPS fix and heading
 * tick, and none of that changes this (its props are refs, flags and a setter).
 */
export const TeamDrawMode = memo(function TeamDrawMode(props: DrawModeProps) {
  const active = useTeamDrawStore((s) => s.active);
  if (!active) return null;
  return <DrawModeBody {...props} />;
});

/** The SVG of my stroke in progress, in screen dp. */
function LocalStroke({
  tool,
  pts,
  color,
  width,
  dashed,
}: {
  tool: ShapeKind;
  pts: readonly ScreenPt[];
  color: string;
  width: number;
  dashed: boolean;
}) {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined || pts.length < 2) return null;
  const dash = dashed ? `${width * 2.2} ${width * 1.8}` : undefined;
  const common = {
    stroke: color,
    strokeWidth: width,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...(dash ? { strokeDasharray: dash } : {}),
  };
  let body;
  if (tool === 'free') {
    body = <Path d={`M${pts.map((p) => `${p[0]} ${p[1]}`).join(' L')}`} fill="none" {...common} />;
  } else if (tool === 'arrow') {
    const ang = Math.atan2(last[1] - first[1], last[0] - first[0]);
    const h = 22;
    const at = (d: number, side: number) =>
      `${last[0] - Math.cos(ang) * d - Math.sin(ang) * side},${last[1] - Math.sin(ang) * d + Math.cos(ang) * side}`;
    body = (
      <>
        <Line x1={first[0]} y1={first[1]} x2={last[0]} y2={last[1]} {...common} />
        <Polygon
          points={`${last[0]},${last[1]} ${at(h, h * 0.55)} ${at(h, -h * 0.55)}`}
          fill={color}
        />
      </>
    );
  } else if (tool === 'circle') {
    const r = Math.hypot(last[0] - first[0], last[1] - first[1]);
    body = <Circle cx={first[0]} cy={first[1]} r={r} fill={color} fillOpacity={0.14} {...common} />;
  } else {
    body = (
      <Path
        d={`M${first[0]} ${first[1]} L${last[0]} ${first[1]} L${last[0]} ${last[1]} L${first[0]} ${last[1]} Z`}
        fill={color}
        fillOpacity={0.14}
        {...common}
      />
    );
  }
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" testID="team-draw-local">
      {body}
    </Svg>
  );
}

function DrawModeBody({
  mapRef,
  cameraRef,
  focused,
  bottomInset = 0,
  locked = false,
  onCredits,
}: DrawModeProps) {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const tool = useTeamDrawStore((s) => s.tool);
  const hintNow = useTeamDrawStore((s) => s.hintNow);
  const menuKey = useTeamDrawStore((s) => s.menu);
  const shapes = useTeamStore((s) => s.drawings);
  const isAdmin = useTeamStore((s) => s.view?.isAdmin ?? false);
  const me = useTeamStore((s) => s.view?.me);
  const units: Units = useSettingsStore((s) => s.units);
  const prefs = useDrawPrefs();
  const own = useOwnColour();
  const snack = useActionSnackbar(5_000);
  const [styleOpen, setStyleOpen] = useState(false);
  const [hint, setHint] = useState(hintNow);
  const [pts, setPts] = useState<readonly ScreenPt[]>([]);
  const [chip, setChip] = useState<string | null>(null);
  const [drawn, setDrawn] = useState<string[]>([]);

  const gesture = useRef(new DrawGesture());
  const view = useRef<Viewport | null>(null);
  const size = useRef({ width: 0, height: 0 });
  const pinch = useRef<Pinch | null>(null);
  const stroke = useRef<StrokeBuilder | null>(null);
  /** The gesture's points so far (the pen timer builds from the latest). */
  const latest = useRef<readonly ScreenPt[]>([]);
  const throttle = useRef(new PenThrottle());
  const dueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ tool, prefs, units, styleOpen, locked });
  useEffect(() => {
    live.current = { tool, prefs, units, styleOpen, locked };
  });

  const done = useCallback(() => {
    gesture.current.reset();
    exitDrawing();
  }, []);
  useScreenSheet(focused, () => {
    if (useTeamDrawStore.getState().menu !== null) useTeamDrawStore.getState().openMenu(null);
    else if (live.current.styleOpen) setStyleOpen(false);
    else done();
  });

  // Entering: read the camera once; flatten it (the projection is pitch 0);
  // stop following (the map must stay where it is drawn on).
  const syncView = useCallback(async () => {
    try {
      const vs = await mapRef.current?.getViewState();
      if (!vs) return;
      view.current = {
        center: [vs.center[0], vs.center[1]],
        zoom: vs.zoom,
        bearing: vs.bearing,
        ...size.current,
      };
      if (vs.pitch > 0.5) {
        cameraRef.current?.easeTo({
          center: [vs.center[0], vs.center[1]],
          pitch: 0,
          duration: 200,
        });
      }
    } catch {
      // The map is mid-teardown: the next stroke tries again.
    }
  }, [mapRef, cameraRef]);
  useEffect(() => {
    useMapStore.getState().setFollowUser(false);
    void syncView();
  }, [syncView]);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);
  useEffect(
    () => () => {
      if (dueTimer.current) clearTimeout(dueTimer.current);
      if (pressTimer.current) clearTimeout(pressTimer.current);
    },
    [],
  );

  const session = () => teamService()?.active ?? null;
  const send = (body: PenBody) => {
    session()?.draw.sendPen(body);
  };
  /**
   * The stroke so far to the team, built only now that the throttle lets one
   * go (never per touch-move). Teammates see it once it is a real stroke: an
   * accidental touch never leaves.
   */
  const sendLatest = () => {
    const vp = view.current;
    const b = stroke.current;
    if (!vp || !b) return;
    const real = b.stroke(latest.current, vp, penStyle(live.current.prefs), MIN_STROKE_DP);
    if (!real) return;
    const body = throttle.current.offer(
      penBody(real, toleranceM(vp.zoom, vp.center[1])),
      clockNow(),
    );
    if (body) send(body);
  };
  /** A move came too soon after the last send: send the latest when the throttle allows. */
  const armDue = () => {
    if (dueTimer.current) return;
    dueTimer.current = setTimeout(
      () => {
        dueTimer.current = null;
        // A timer is no clock: one that fires early (a busy JS thread, a clock
        // step) waits again rather than building a body the throttle refuses.
        if (clockNow() < throttle.current.readyAt()) armDue();
        else sendLatest();
      },
      Math.max(0, throttle.current.readyAt() - clockNow()),
    );
  };
  const endStroke = () => {
    if (dueTimer.current) clearTimeout(dueTimer.current);
    dueTimer.current = null;
    throttle.current.reset();
    latest.current = [];
    setPts([]);
    setChip(null);
  };
  const canTouch = (key: string) => isAdmin || key.startsWith(`${me ?? '?'}:`);

  const [menuPlace, setMenuPlace] = useState<{ top: number } | { bottom: number }>({
    top: insets.top + 70,
  });
  /** Where a shape's menu goes: under the top bar or on the tool bar, whichever hides less of it. */
  const placeMenu = (key: string) => {
    const menuTop = insets.top + 70;
    const menuBottom = drawBarBottom(insets.bottom, bottomInset) + BAR_H + 8;
    const shape = useTeamStore.getState().drawings.find((x) => x.key === key);
    const vp = view.current;
    const side =
      shape === undefined || vp === null
        ? 'top'
        : menuSide(
            screenSpan(shape, vp),
            [menuTop, menuTop + MENU_H],
            [vp.height - menuBottom - MENU_H, vp.height - menuBottom],
          );
    setMenuPlace(side === 'top' ? { top: menuTop } : { bottom: menuBottom });
  };

  const run = (actions: readonly GestureAction[]) => {
    for (const a of actions) {
      // Read per action: a 'begin' re-reads the camera, a pinch moves it.
      const vp = view.current;
      switch (a.type) {
        case 'begin':
          setStyleOpen(false);
          stroke.current = new StrokeBuilder(
            live.current.tool,
            session()?.newId() ?? String(Date.now()),
          );
          throttle.current.reset();
          latest.current = [a.at];
          setPts([a.at]);
          // The camera may have moved since the last stroke (the recording's
          // camera, a navigation glide): every stroke starts from a fresh read.
          void syncView();
          break;
        case 'update': {
          latest.current = a.pts;
          setPts([...a.pts]);
          const b = stroke.current;
          setChip(vp && b ? b.chip(a.pts, vp, live.current.units) : null);
          if (clockNow() >= throttle.current.readyAt()) sendLatest();
          else armDue();
          break;
        }
        case 'end': {
          const b = stroke.current;
          const s =
            vp && b ? b.stroke(a.pts, vp, penStyle(live.current.prefs), MIN_STROKE_DP) : null;
          if (s && vp) {
            const err = session()?.draw.finish(
              s,
              toleranceM(vp.zoom, vp.center[1]),
              live.current.prefs.fadeMs,
            );
            if (err === null) setDrawn((d) => [...d, s.id]);
            else if (err !== undefined) snack.show('That shape could not be sent');
          }
          stroke.current = null;
          endStroke();
          break;
        }
        case 'cancel':
          // A stroke already seen live fades from teammates' maps with its
          // ttl (the protocol has no withdrawal; core review #683).
          stroke.current = null;
          endStroke();
          break;
        case 'tap':
        case 'long-press': {
          if (live.current.styleOpen) {
            setStyleOpen(false);
            break;
          }
          const map = mapRef.current;
          if (!map) break;
          const kind = a.type;
          void hitTestTeamDraw(map, a.at[0], a.at[1]).then((key) => {
            const store = useTeamDrawStore.getState();
            if (key === null || !canTouch(key)) {
              if (kind === 'tap') store.select(null);
              return;
            }
            if (kind === 'tap') store.select(store.selected === key ? null : key);
            else {
              placeMenu(key);
              store.openMenu(key);
            }
          });
          break;
        }
        case 'pinch-start':
          pinch.current = vp ? startPinch(a.a, a.b, vp) : null;
          break;
        case 'pinch-move': {
          const pc = pinch.current;
          if (!pc || !view.current) break;
          const cam = pinchCamera(pc, a.a, a.b);
          view.current = { ...view.current, ...cam };
          cameraRef.current?.jumpTo({ center: cam.center, zoom: cam.zoom, bearing: cam.bearing });
          break;
        }
        case 'pinch-end':
          pinch.current = null;
          break;
      }
    }
  };

  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  // The glove lock engaged mid-stroke: the stroke is cancelled, not finished.
  useEffect(() => {
    if (!locked) return;
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    runRef.current(gesture.current.reset());
  }, [locked]);

  /**
   * Touches in the canvas's own dp, which are the map's: the canvas is pinned
   * to the map's top-left and its children take no touch. Never `pageY` minus
   * `measureInWindow()`: on edge-to-edge Android the two disagree by the status
   * bar, and every stroke landed ~52 dp under the finger (2.5.2 QA).
   */
  const touchesOf = (e: GestureResponderEvent): Touch[] =>
    e.nativeEvent.touches.map((x) => ({ id: x.identifier, x: x.locationX, y: x.locationY }));
  const onTouches = (e: GestureResponderEvent) => {
    run(gesture.current.touches(touchesOf(e), Date.now()));
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    const at = gesture.current.longPressAt();
    if (at !== null) {
      pressTimer.current = setTimeout(
        () => run(gesture.current.longPress(Date.now())),
        Math.max(0, at - Date.now()),
      );
    }
  };
  /** The MAP's size (the root fills it): the projection's centre is the map's, not the canvas's. */
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    size.current = { width, height };
    if (view.current) view.current = { ...view.current, width, height };
  };

  const clearMine = () => {
    const s = session();
    if (!s) return;
    const removed = s.draw.clearMine();
    useTeamStore.getState().refresh();
    setDrawn([]);
    if (removed.length === 0) {
      snack.show('You have no drawings on the map');
      return;
    }
    snack.show(`Cleared ${removed.length} drawing${removed.length === 1 ? '' : 's'}`, [
      {
        label: 'Undo',
        onPress: () => {
          s.draw.restore(removed);
          useTeamStore.getState().refresh();
        },
      },
    ]);
  };
  const undo = () => {
    const id = drawn[drawn.length - 1];
    if (id === undefined || me === undefined) return;
    session()?.draw.remove(me, id);
    useTeamStore.getState().refresh();
    setDrawn((d) => d.slice(0, -1));
  };

  const color = memberColor(prefs.colour);
  const lineW = LINE_DP[prefs.width];
  const menuShape = menuKey === null ? undefined : shapes.find((s) => s.key === menuKey);
  const barBottom = drawBarBottom(insets.bottom, bottomInset);

  return (
    <View
      style={[StyleSheet.absoluteFill, BOTTOM_LAYER.drawMode]}
      // Glove lock: every touch falls through to the lock's shield (and the
      // panel's hold-to-unlock), as for the rest of the map's chrome.
      pointerEvents={locked ? 'none' : 'box-none'}
      importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={locked}
      onLayout={onLayout}
      testID="team-draw-mode"
    >
      <View
        style={[styles.canvas, { bottom: bottomInset }]}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={onTouches}
        onResponderStart={onTouches}
        onResponderMove={onTouches}
        onResponderEnd={onTouches}
        onResponderRelease={onTouches}
        onResponderTerminate={() => run(gesture.current.reset())}
        accessibilityLabel="Drawing canvas: one finger draws, two fingers move the map"
        testID="team-draw-canvas"
      >
        <LocalStroke tool={tool} pts={pts} color={color} width={lineW} dashed={prefs.dashed} />
      </View>

      <View style={[styles.top, { top: insets.top + 8, backgroundColor: t.map.chrome }]}>
        <Icon source="draw" size={22} color={t.map.chromeInk} />
        <View style={styles.flex}>
          <Text style={[styles.t1, { color: t.map.chromeInk }]} numberOfLines={1}>
            Drawing
          </Text>
          <Text style={[styles.t2, { color: t.map.chromeInk }]} numberOfLines={1}>
            Team sees it live
          </Text>
        </View>
        <Pressable
          onPress={clearMine}
          style={styles.topBtn}
          accessibilityRole="button"
          accessibilityLabel="Clear mine"
          testID="team-draw-clear"
        >
          <Icon source="broom" size={20} color={t.map.chromeInk} />
          <Text style={[styles.topBtnText, { color: t.map.chromeInk }]}>Clear mine</Text>
        </Pressable>
        <Pressable
          onPress={done}
          style={[styles.topBtn, styles.done, { backgroundColor: drawChrome.active }]}
          accessibilityRole="button"
          accessibilityLabel="Done"
          testID="team-draw-done"
        >
          <Text style={[styles.topBtnText, { color: drawChrome.onActive }]}>Done</Text>
        </Pressable>
      </View>

      {chip !== null ? (
        <View
          style={[styles.chip, { top: insets.top + 70 }]}
          pointerEvents="none"
          testID="team-draw-chip"
        >
          <Icon source={TOOL_ICON[tool]} size={17} color={color} />
          <Text style={[styles.chipText, { color: drawChrome.chipInk }]}>{chip}</Text>
        </View>
      ) : hint ? (
        <View
          style={[styles.hint, { top: insets.top + 70, backgroundColor: t.map.chip }]}
          pointerEvents="none"
          testID="team-draw-hint"
        >
          <Icon source="gesture-pinch" size={18} color={t.map.chipInk} />
          <Text style={[styles.hintText, { color: t.map.chipInk }]}>
            One finger draws · two fingers move the map
          </Text>
        </View>
      ) : null}

      {styleOpen && (
        <DrawStylePopover
          prefs={prefs}
          own={own}
          bottom={barBottom + 74}
          onChange={(next) => useTeamDrawStore.getState().setPrefs(next)}
          onClose={() => setStyleOpen(false)}
        />
      )}
      {menuShape && (
        <ShapeMenu
          shape={menuShape}
          place={menuPlace}
          onClose={() => useTeamDrawStore.getState().openMenu(null)}
        />
      )}

      {/* The map's credits stay on the map in drawing mode (OpenStreetMap's
        attribution guideline), just above the tool bar. */}
      {onCredits !== undefined && (
        <View
          style={[styles.credits, { bottom: barBottom + BAR_H + CREDITS_GAP }]}
          pointerEvents="box-none"
        >
          <MapCreditsButton onPress={() => onCredits(true)} />
        </View>
      )}

      <View style={[styles.bar, { bottom: barBottom }]} testID="team-draw-toolbar">
        {TOOLS.map(({ k, icon, label }) => {
          const on = k === tool;
          return (
            <Pressable
              key={k}
              onPress={() => useTeamDrawStore.getState().setTool(k)}
              style={[styles.tool, on && { backgroundColor: drawChrome.active }]}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: on }}
              testID={`team-draw-tool-${k}`}
            >
              <Icon source={icon} size={26} color={on ? drawChrome.onActive : drawChrome.barInk} />
            </Pressable>
          );
        })}
        <View style={[styles.divider, { backgroundColor: drawChrome.barDivider }]} />
        <Pressable
          onPress={() => setStyleOpen((o) => !o)}
          style={[
            styles.style,
            { borderColor: styleOpen ? drawChrome.active : drawChrome.barOutline },
            styleOpen && { backgroundColor: drawChrome.activeSoft },
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Style, fades after ${fadeLabel(prefs.fadeMs)}`}
          accessibilityState={{ expanded: styleOpen }}
          testID="team-draw-style-button"
        >
          <Svg width={34} height={18}>
            <Path
              d="M3 14 C9 3 15 3 17 9 S26 16 31 4"
              fill="none"
              stroke={color}
              strokeWidth={Math.min(lineW, 6)}
              strokeLinecap="round"
              {...(prefs.dashed ? { strokeDasharray: `${lineW * 1.6} ${lineW * 1.4}` } : {})}
            />
          </Svg>
          <View style={styles.fade}>
            <Icon source="timer-sand" size={11} color={drawChrome.barInkMuted} />
            <Text style={[styles.fadeText, { color: drawChrome.barInkMuted }]}>
              {fadeLabel(prefs.fadeMs)}
            </Text>
          </View>
        </Pressable>
        <View style={styles.flex} />
        <Pressable
          onPress={undo}
          disabled={drawn.length === 0}
          style={[styles.tool, drawn.length === 0 && styles.dim]}
          accessibilityRole="button"
          accessibilityLabel="Undo my last shape"
          accessibilityState={{ disabled: drawn.length === 0 }}
          testID="team-draw-undo"
        >
          <Icon source="undo" size={26} color={drawChrome.barInk} />
        </Pressable>
      </View>
      <ActionSnackbar snack={snack.current} style={{ bottom: barBottom + 70 }} />
    </View>
  );
}

const BAR_H = 66;
/** The shape menu's height, about (its note field and buttons). */
const MENU_H = 260;
const CREDITS_GAP = 10;
/** The ⓘ button's height (MapCredits). */
const CREDITS_H = 32;

/** The tool bar's bottom: on the recording panel when it is up (the panel holds the safe area). */
export function drawBarBottom(safeBottom: number, bottomInset: number): number {
  return (bottomInset > 0 ? bottomInset : safeBottom) + 12;
}

/** Where the credits sheet docks in drawing mode: just above the ⓘ over the tool bar. */
export function drawCreditsSheetBottom(safeBottom: number, bottomInset: number): number {
  return drawBarBottom(safeBottom, bottomInset) + BAR_H + CREDITS_GAP + CREDITS_H + 8;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  canvas: { position: 'absolute', top: 0, left: 0, right: 0 },
  credits: { position: 'absolute', left: 16, zIndex: 9 },
  top: {
    position: 'absolute',
    left: 16,
    right: 16,
    height: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 4,
    zIndex: 9,
    elevation: 6,
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  t1: { fontSize: 15, fontWeight: '800' },
  t2: { fontSize: 12, opacity: 0.7 },
  topBtn: {
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  topBtnText: { fontSize: 14, fontWeight: '800' },
  done: { paddingHorizontal: 18 },
  chip: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: drawChrome.chip,
    borderRadius: 15,
    paddingVertical: 6,
    paddingLeft: 10,
    paddingRight: 12,
    zIndex: 6,
  },
  chipText: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  hint: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 16,
    paddingVertical: 7,
    paddingHorizontal: 12,
    zIndex: 6,
  },
  hintText: { fontSize: 13, fontWeight: '700' },
  bar: {
    position: 'absolute',
    left: 12,
    right: 12,
    height: BAR_H,
    borderRadius: 24,
    backgroundColor: drawChrome.bar,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    zIndex: 9,
    elevation: 8,
    shadowColor: palette.shadow,
    shadowOpacity: 0.35,
    shadowRadius: 11,
    shadowOffset: { width: 0, height: 8 },
  },
  tool: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dim: { opacity: 0.35 },
  divider: { width: 1, height: 34, marginHorizontal: 4 },
  style: {
    width: 62,
    height: 52,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  fade: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  fadeText: { fontSize: 10, fontWeight: '800' },
});
