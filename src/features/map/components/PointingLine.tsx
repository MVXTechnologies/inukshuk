import {
  pointingLineFeatures,
  resolveLengthM,
  resolveTickStep,
  type ViewBounds,
} from '@core/geo/pointingLine';
import {
  POINTING_LINE_WIDTH_DP,
  pointingLineCasing,
  type PointingLineSettings,
} from '@core/map/pointingLineSettings';
import type { LatLng } from '@core/models';
import {
  choosePointingBearing,
  createCourseTracker,
  createHeadingGate,
  type CourseSample,
} from '@core/nav';
import { teamLabelFont } from '@features/team/map/TeamMapLayers';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeHeading } from '../useCompass';
import { PUCK_RING_LAYER_ID } from './PuckLayers';

/** With no magnetometer, re-read the course this often so a stop hides the line, ms. */
const COG_REFRESH_MS = 3000;

/** Layer ids (stable: tests and e2e may name them). */
export const POINTING_LINE_LAYERS = {
  casing: 'pointing-line-casing',
  line: 'pointing-line',
  end: 'pointing-line-end',
  labels: 'pointing-line-labels',
} as const;

export interface PointingLineProps {
  /** Your position: the line starts here, and hides without one. */
  location: LatLng | null;
  /** The settled visible bounds (camera idle), for the "Edge" length. */
  bounds: ViewBounds | null;
  /** The settled zoom: sizes the ticks, picks the Auto step. */
  zoom: number | null;
  /** The style's glyph host; none = no labels (raster and satellite styles). */
  glyphs: string | undefined;
  /** Hidden while the map is a tool: waypoint move, region select, the map maker. */
  suppressed: boolean;
}

/**
 * The pointing line on the map (#681): from you along your heading, your
 * course or a fixed bearing, drawn as MapLibre layers (one GeoJSON source:
 * the line and its casing, tick segments, the end dot, labels), so its
 * length is true on the ground at any zoom. Settings: Map layers › Map ›
 * Pointing line (`@core/map/pointingLineSettings`); geometry:
 * `@core/geo/pointingLine`; direction rules: `@core/nav/pointingSource`.
 *
 * Cost: off (the default) it renders nothing and subscribes to nothing. On,
 * it owns the heading subscription, so a heading tick re-renders this leaf
 * only, never MapScreen — gated to 4 Hz with a 1° dead-band (a held turn is
 * flushed on a timer, so the last position of a turn is never lost). Each
 * accepted tick rebuilds the feature collection: O(ticks) trig, one end
 * point plus one destination per tick (capped), then one native source
 * update. The edge clip and the tick sizes use the bounds and zoom of the
 * idle camera — never per frame.
 */
export const PointingLine = memo(function PointingLine({
  location,
  suppressed,
  ...rest
}: PointingLineProps) {
  const cfg = useSettingsStore((s) => s.pointingLine);
  if (!cfg.enabled || suppressed || location === null) return null;
  return <LivePointingLine cfg={cfg} location={location} {...rest} />;
});

function LivePointingLine({
  cfg,
  location,
  bounds,
  zoom,
  glyphs,
}: Omit<PointingLineProps, 'suppressed' | 'location'> & {
  cfg: PointingLineSettings;
  location: LatLng;
}) {
  const tokens = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const { mapInk, mapHalo } = tokens.team;
  const font = teamLabelFont(glyphs);

  // The compass, only while the line follows it: 4 Hz, ≥ 1° turns.
  const wantsCompass = cfg.direction === 'heading';
  const [compassDeg, setCompassDeg] = useState<number | null>(null);
  useEffect(() => {
    if (!wantsCompass) return;
    const gate = createHeadingGate();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeHeading(({ headingDeg }) => {
      const r = gate.push(headingDeg, Date.now());
      if (r.kind === 'emit') setCompassDeg(r.headingDeg);
      else if (r.kind === 'wait' && timer === null) {
        timer = setTimeout(() => {
          timer = null;
          const held = gate.flush(Date.now());
          if (held !== null) setCompassDeg(held);
        }, r.inMs);
      }
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [wantsCompass]);

  // Course over ground: for Course, and for Heading with no magnetometer.
  const wantsCourse =
    cfg.direction === 'course' || (cfg.direction === 'heading' && compassDeg === null);
  const courseRef = useRef(createCourseTracker());
  const [course, setCourse] = useState<CourseSample>({ speedMps: 0, courseDeg: null });
  useEffect(() => {
    if (!wantsCourse) return;
    const push = () => {
      const next = courseRef.current.push(location, Date.now());
      setCourse((prev) =>
        prev.speedMps === next.speedMps && prev.courseDeg === next.courseDeg ? prev : next,
      );
    };
    push();
    // A watch can go quiet when you stop: re-reading the same fix lets the
    // speed decay below the threshold, so the line hides instead of freezing.
    const id = setInterval(push, COG_REFRESH_MS);
    return () => clearInterval(id);
  }, [wantsCourse, location]);

  const bearing = choosePointingBearing(cfg.direction, cfg.fixedBearingDeg, compassDeg, course);
  const bearingDeg = bearing?.bearingDeg ?? null;
  const cog = bearing?.kind === 'cog';
  const hasFont = font !== null;

  const data = useMemo(() => {
    if (bearingDeg === null) return null;
    const lengthM = resolveLengthM(cfg.length, location, bearingDeg, bounds);
    if (lengthM === null || !(lengthM > 0)) return null;
    return pointingLineFeatures({
      origin: location,
      bearingDeg,
      lengthM,
      tickStep: resolveTickStep(cfg.ticks, zoom, location.latitude, units),
      zoom,
      labelMajors: cfg.labelEvery5th && hasFont,
      endLabel: cog && hasFont ? 'COG' : null,
    });
  }, [
    bearingDeg,
    cog,
    cfg.length,
    cfg.ticks,
    cfg.labelEvery5th,
    location,
    bounds,
    zoom,
    hasFont,
    units,
  ]);

  // Memoised children: <GeoJSONSource> re-serialises its data whenever a
  // child's identity changes; a heading tick must only change the data.
  const layers = useMemo(() => {
    const w = POINTING_LINE_WIDTH_DP[cfg.width];
    const casing = pointingLineCasing(cfg.color);
    const strokes = ['match', ['get', 'kind'], ['line', 'tick', 'major'], true, false];
    return [
      <Layer
        key="casing"
        id={POINTING_LINE_LAYERS.casing}
        beforeId={PUCK_RING_LAYER_ID}
        type="line"
        filter={strokes as never}
        layout={{ 'line-cap': 'round' }}
        paint={{
          'line-color': casing,
          'line-opacity': 0.9,
          'line-width': ['match', ['get', 'kind'], 'line', w + 2.5, 'major', 4.2, 3.7] as never,
        }}
      />,
      <Layer
        key="line"
        id={POINTING_LINE_LAYERS.line}
        beforeId={PUCK_RING_LAYER_ID}
        type="line"
        filter={strokes as never}
        layout={{ 'line-cap': 'round' }}
        paint={{
          'line-color': cfg.color,
          'line-width': ['match', ['get', 'kind'], 'line', w, 'major', 2, 1.5] as never,
        }}
      />,
      <Layer
        key="end"
        id={POINTING_LINE_LAYERS.end}
        beforeId={PUCK_RING_LAYER_ID}
        type="circle"
        filter={['==', ['get', 'kind'], 'end'] as never}
        paint={{
          'circle-radius': w + 1.5,
          'circle-color': cfg.color,
          'circle-stroke-color': casing,
          'circle-stroke-width': 1.5,
          'circle-pitch-alignment': 'map',
        }}
      />,
      ...(font
        ? [
            <Layer
              key="labels"
              id={POINTING_LINE_LAYERS.labels}
              beforeId={PUCK_RING_LAYER_ID}
              type="symbol"
              filter={['==', ['get', 'kind'], 'label'] as never}
              layout={{
                'text-field': ['get', 'text'] as never,
                'text-font': font,
                'text-size': 11,
                // A handful of labels on a line you asked for: never culled.
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{ 'text-color': mapInk, 'text-halo-color': mapHalo, 'text-halo-width': 2 }}
            />,
          ]
        : []),
    ];
  }, [cfg.width, cfg.color, font, mapInk, mapHalo]);

  if (data === null) return null;
  return (
    <GeoJSONSource id="pointing-line" data={data}>
      {layers}
    </GeoJSONSource>
  );
}
