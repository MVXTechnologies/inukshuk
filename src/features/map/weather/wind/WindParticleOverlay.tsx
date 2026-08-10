import { PARTICLES_MAX_PITCH_DEG } from '@core/weather/windCoverage';
import { fadeStep, initialPerfState, perfStep, type WindPerfState } from '@core/weather/windPerf';
import {
  advectionUvPerMps,
  fieldClipMatrix,
  isRenderableView,
  viewportGridRect,
  type WindViewState,
} from '@core/weather/windProjection';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { useEffect, useRef } from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import { WindGl, type WindGlData } from './windGl';

/** Spawn rect / advection for the fade-out clear pass, which draws nothing. */
const FULL_GRID = { minU: 0, minV: 0, maxU: 1, maxV: 1 };
const NO_ADVECTION = { x: 0, y: 0 };

export interface WindOverlayProps {
  /** Encoded wind texture + geo, or null while loading / failed. */
  data: (WindGlData & { lon0: number }) | null;
  /** Latest camera state, mutated at gesture rate — read per frame, never a prop re-render. */
  viewRef: React.RefObject<WindViewState | null>;
  /** True while a gesture is in progress (overlay fades out, advection pauses). */
  interacting: boolean;
  /** Fetch-anchor identity: a change forces a particle re-seed + trail clear. */
  anchorKey: string | null;
}

/**
 * The transparent GL overlay that draws the wind streaks (weather M3). A
 * plain absolute-fill GLView over the MapView — expo-gl's Android GLView is
 * a TextureView honouring transparency — with the ported webgl-wind
 * renderer driving a ~30 fps loop.
 *
 * Everything dynamic flows through refs so the loop never depends on React
 * re-renders: camera (viewRef, written by onRegionIsChanging), wind data,
 * gesture state, reseed requests. The loop self-throttles via the pure
 * windPerf ladder — particle count first, then a one-shot static streak
 * render — and idles (no GL work) whenever there is nothing to draw.
 *
 * Known expo-gl limitation (dev note): GLView renders nothing under remote
 * JS debugging; test wind on-device or in release builds.
 */
export function WindParticleOverlay({ data, viewRef, interacting, anchorKey }: WindOverlayProps) {
  const windRef = useRef<WindGl | null>(null);
  const glGen = useRef(0);
  const dataRef = useRef<WindOverlayProps['data']>(null);
  const dataDirty = useRef(false);
  const interactingRef = useRef(interacting);
  const reseedRequested = useRef(false);
  const perfRef = useRef<WindPerfState>(initialPerfState());

  // Prop → ref mirrors (the loop reads refs only).
  useEffect(() => {
    dataRef.current = data;
    dataDirty.current = true;
  }, [data]);
  useEffect(() => {
    // Falling edge of a gesture = settle: re-seed so streaks re-form cleanly
    // on the new view (Windy's own mobile behaviour).
    if (interactingRef.current && !interacting) reseedRequested.current = true;
    interactingRef.current = interacting;
  }, [interacting]);
  const lastAnchorKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastAnchorKey.current !== null && anchorKey !== lastAnchorKey.current) {
      reseedRequested.current = true;
    }
    lastAnchorKey.current = anchorKey;
  }, [anchorKey]);

  // Unmount: invalidate the generation so the RAF loop stops and disposes.
  useEffect(
    () => () => {
      glGen.current++;
    },
    [],
  );

  const onContextCreate = (gl: ExpoWebGLRenderingContext) => {
    const gen = ++glGen.current;
    let wind: WindGl;
    try {
      wind = new WindGl(gl as unknown as WebGLRenderingContext);
    } catch {
      // Shader compile/link failure on an exotic GPU: gradient-only, silently.
      // (The shader stage-linkage lint in windGl.test.ts is what keeps a
      // BUILD-time shader bug from reaching this silent runtime path.)
      return;
    }
    wind.pointScale = PixelRatio.get();
    windRef.current = wind;
    dataDirty.current = true;
    let uploadedData: WindOverlayProps['data'] = null;
    let opacity = 0;
    let lastFrameAt = 0;
    let lastDrawAt: number | null = null;

    const frame = () => {
      if (gen !== glGen.current) {
        wind.dispose();
        if (windRef.current === wind) windRef.current = null;
        return;
      }
      requestAnimationFrame(frame);
      const now = performance.now();
      // Cadence is a ladder rung: the slowest step still animates.
      const interval = perfRef.current.frameIntervalMs;
      if (now - lastFrameAt < interval - 2) return;
      const dt = lastFrameAt === 0 ? interval : now - lastFrameAt;
      lastFrameAt = now;

      // A camera whose layout size has not landed yet would project every
      // particle off screen; idle until it is real (see isRenderableView).
      const seeded = viewRef.current;
      const view = seeded !== null && isRenderableView(seeded) ? seeded : null;
      const d = dataRef.current;
      if (dataDirty.current) {
        dataDirty.current = false;
        if (d !== null) wind.setWind(d);
        if (uploadedData === null && d !== null) {
          wind.setNumParticles(perfRef.current.particleCount);
          wind.clearTrails();
        }
        uploadedData = d;
      }
      const idle = d === null || view === null || !wind.hasWind;
      const hidden =
        idle || interactingRef.current || (view !== null && view.pitch > PARTICLES_MAX_PITCH_DEG);
      const target = hidden ? 0 : 1;
      const prevOpacity = opacity;
      opacity = fadeStep(opacity, target, dt);
      if (d === null || view === null || (opacity === 0 && target === 0 && prevOpacity === 0)) {
        // Nothing to draw: free the GPU entirely this frame. One clear pass
        // when we just faded out.
        if (prevOpacity > 0 && opacity === 0) {
          wind.resize(perfRef.current.resolutionScale);
          wind.draw(new Float32Array(16), 0, FULL_GRID, NO_ADVECTION);
          gl.endFrameEXP();
          gl.flushEXP(); // the clear has to reach the screen too — see below
        }
        return;
      }

      if (reseedRequested.current) {
        reseedRequested.current = false;
        wind.reseed();
        wind.clearTrails();
        lastDrawAt = null;
      }

      wind.resize(perfRef.current.resolutionScale);
      const matrix = fieldClipMatrix(view, d.lon0, d.latNorth);
      // Particles spawn in the padded VIEWPORT, not across the whole fetched
      // grid — the grid is deliberately much larger (fetch padding + the
      // 0.5° WCS floor), so grid-wide seeding leaves the screen empty.
      const geo = {
        lon0: d.lon0,
        lat0: d.latNorth,
        lonSpan: d.lonSpanDeg,
        latSpan: d.latSpanDeg,
      };
      const spawn = viewportGridRect(view, geo);
      // Advection is screen-relative for the same reason (see the helper).
      const uvPerMps = advectionUvPerMps(view, geo, spawn);

      // Perf ladder feeds on executed animated frames only.
      if (lastDrawAt !== null && opacity > 0.5) {
        const prev = perfRef.current;
        perfRef.current = perfStep(prev, now - lastDrawAt);
        if (perfRef.current.particleCount !== prev.particleCount) {
          wind.setNumParticles(perfRef.current.particleCount);
          wind.clearTrails();
        }
        // A resolution change reallocates the trail buffers; start them clean.
        if (perfRef.current.resolutionScale !== prev.resolutionScale) wind.clearTrails();
      }
      lastDrawAt = now;
      wind.draw(matrix, opacity, spawn, uvPerMps);
      gl.endFrameEXP();
      // ...and then FORCE the queued batch through. This line is the
      // difference between a visible overlay and a blank one.
      //
      // endFrameEXP only marks the context as needing a redraw and asks for a
      // flush via dispatch_async on expo-gl's GL queue; the MSAA resolve
      // (blitFramebuffers) and the display-link present happen off the back of
      // that. When the loop drives frames itself — as this one does, rather
      // than rendering from expo-gl's own callback — that asynchronous request
      // never lands and NOTHING is ever presented, while every JS-side
      // signal (frame timing, particle state, GL error state) looks perfectly
      // healthy. It cost days to find because the renderer is not at fault.
      //
      // flushEXP enqueues an empty BLOCKING op, so the batch executes on the
      // GL queue before this returns and the frame reaches the screen. It is
      // the cheapest such op expo-gl offers (gl.getError() also works, at the
      // cost of a real round trip). Verified by scripts/wind-motion-check.mjs:
      // without this line the two-capture diff is 0 pixels, with it ~220k.
      gl.flushEXP();
    };
    frame();
  };

  return (
    <GLView
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onContextCreate={onContextCreate}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
