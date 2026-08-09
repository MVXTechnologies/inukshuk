import { PARTICLES_MAX_PITCH_DEG } from '@core/weather/windCoverage';
import {
  fadeStep,
  FRAME_INTERVAL_MS,
  initialPerfState,
  perfStep,
  type WindPerfState,
} from '@core/weather/windPerf';
import { fieldClipMatrix, type WindViewState } from '@core/weather/windProjection';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { useEffect, useRef } from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import { WindGl, type WindGlData } from './windGl';

/** Frames of the one-shot static render when animation is degraded away. */
const STATIC_BURST_FRAMES = 70;

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
  const staticFramesLeft = useRef<number | null>(null);

  // Prop → ref mirrors (the loop reads refs only).
  useEffect(() => {
    dataRef.current = data;
    dataDirty.current = true;
    // A fresh field re-arms animation if the perf ladder had gone static.
    if (perfRef.current.staticMode)
      perfRef.current = initialPerfState(perfRef.current.particleCount);
    staticFramesLeft.current = null;
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
      if (now - lastFrameAt < FRAME_INTERVAL_MS - 2) return; // ~30 fps cap
      const dt = lastFrameAt === 0 ? FRAME_INTERVAL_MS : now - lastFrameAt;
      lastFrameAt = now;

      const view = viewRef.current;
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
      const staticDone = staticFramesLeft.current !== null && staticFramesLeft.current <= 0;
      const hidden =
        idle || interactingRef.current || (view !== null && view.pitch > PARTICLES_MAX_PITCH_DEG);
      const target = hidden ? 0 : 1;
      const prevOpacity = opacity;
      opacity = fadeStep(opacity, target, dt);
      if (
        d === null ||
        view === null ||
        (opacity === 0 && target === 0 && prevOpacity === 0) ||
        staticDone
      ) {
        // Nothing to draw (or the static frame is already on screen): free
        // the GPU entirely this frame. One clear pass when we just faded out.
        if (prevOpacity > 0 && opacity === 0 && !staticDone) {
          wind.resize();
          wind.draw(new Float32Array(16), 0);
          gl.endFrameEXP();
        }
        return;
      }

      if (reseedRequested.current) {
        reseedRequested.current = false;
        wind.reseed();
        wind.clearTrails();
        if (perfRef.current.staticMode) {
          // Re-run the one-shot static render on the fresh view.
          staticFramesLeft.current = null;
        }
        lastDrawAt = null;
      }

      wind.resize();
      const matrix = fieldClipMatrix(view, d.lon0, d.latNorth);

      if (perfRef.current.staticMode) {
        // Static streaks: burst-advect trails once, leave the frame up.
        if (staticFramesLeft.current === null) staticFramesLeft.current = STATIC_BURST_FRAMES;
        wind.draw(matrix, opacity);
        staticFramesLeft.current -= 1;
        gl.endFrameEXP();
        return;
      }

      // Perf ladder feeds on executed animated frames only.
      if (lastDrawAt !== null && opacity > 0.5) {
        const prevCount = perfRef.current.particleCount;
        perfRef.current = perfStep(perfRef.current, now - lastDrawAt);
        if (perfRef.current.particleCount !== prevCount && !perfRef.current.staticMode) {
          wind.setNumParticles(perfRef.current.particleCount);
          wind.clearTrails();
        }
      }
      lastDrawAt = now;
      wind.draw(matrix, opacity);
      gl.endFrameEXP();
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
