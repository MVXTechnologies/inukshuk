import { fixAltitude } from '@core/gnss/receiver';
import { stripNeeds } from '@core/infoStrip/deps';
import { datumTag } from '@core/infoStrip/edit';
import { createMovingSpeedWindow } from '@core/infoStrip/movingSpeed';
import { stripStationParams } from '@core/infoStrip/tides';
import { destinationName } from '@core/infoStrip/target';
import type {
  DatumView,
  DepsSnapshot,
  FieldRef,
  FollowSnapshot,
  GnssSnapshot,
  InfoStrip,
  StripFix,
} from '@core/infoStrip/types';
import type { LatLng, TrackStats } from '@core/models';
import { createCourseTracker, type CourseSample } from '@core/nav/headingTape';
import { createHeadingGate } from '@core/nav/pointingSource';
import type { HeroData } from '@core/recording/panel';
import { useGnssStore } from '@state/gnssStore';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useNavigationStore } from '@state/navigationStore';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useCenterElevation } from '../centerElevation';
import type { FollowState } from '../nav/useFollowTrail';
import { subscribeHeading } from '../useCompass';
import { useInstalledExtensions } from './stripSettings';
import { useStripTides } from './useStripTides';

/** What MapScreen already holds per fix, handed to the strip (no new MapScreen work). */
export interface StripInputs {
  /** The user's position, or null before the first fix. */
  location: LatLng | null;
  /** The last phone fix (altitude, accuracy, speed), or null. */
  fix: { altitude?: number; accuracy?: number; speed?: number } | null;
  follow: FollowState | null;
  /** The recorder's numbers while recording, else null. */
  recording: { stats: TrackStats; elapsedS: number; liveSpeedMps: number } | null;
}

/** How often the course tracker re-reads the last fix, so the speed decays at a stop (as the pointing line). */
export const COURSE_REFRESH_MS = 3000;
/** The compass at 4 Hz with a 1° dead-band (the pointing line's gate), only while `on`. */
function useGatedHeading(on: boolean): number | null {
  const [deg, setDeg] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    const gate = createHeadingGate();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeHeading(({ headingDeg }) => {
      const r = gate.push(headingDeg, Date.now());
      if (r.kind === 'emit') setDeg(r.headingDeg);
      else if (r.kind === 'wait' && timer === null) {
        timer = setTimeout(() => {
          timer = null;
          const held = gate.flush(Date.now());
          if (held !== null) setDeg(held);
        }, r.inMs);
      }
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [on]);
  return on ? deg : null;
}

/** Course over ground from the fixes, only while `on` (re-read on a timer so it decays when you stop). */
function useCourse(on: boolean, location: LatLng | null): CourseSample | null {
  const tracker = useRef(createCourseTracker());
  const [course, setCourse] = useState<CourseSample | null>(null);
  useEffect(() => {
    if (!on || location === null) return;
    const push = () => {
      const next = tracker.current.push(location, Date.now());
      setCourse((prev) =>
        prev !== null && prev.speedMps === next.speedMps && prev.courseDeg === next.courseDeg
          ? prev
          : next,
      );
    };
    push();
    const id = setInterval(push, COURSE_REFRESH_MS);
    return () => clearInterval(id);
  }, [on, location]);
  return on && location !== null ? course : null;
}

/**
 * The clock (each `ms`, never with null) and, read on its ticks, the moving
 * speed over the last 10 minutes (only while `moving`): the window is fed
 * one push per new fix.
 */
function useClockAndMovingSpeed(
  ms: number | null,
  moving: boolean,
  location: LatLng | null,
): { nowMs: number; movingSpeedMps: number | null } {
  const windowRef = useRef(createMovingSpeedWindow());
  const [clock, setClock] = useState(() => ({
    nowMs: Date.now(),
    movingSpeedMps: null as number | null,
  }));
  useEffect(() => {
    if (moving && location !== null) windowRef.current.push(location, Date.now());
  }, [moving, location]);
  useEffect(() => {
    if (moving) return;
    windowRef.current.reset();
  }, [moving]);
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => {
      const nowMs = Date.now();
      setClock({ nowMs, movingSpeedMps: moving ? windowRef.current.speedMps(nowMs) : null });
    }, ms);
    return () => clearInterval(id);
  }, [ms, moving]);
  return moving ? clock : { nowMs: clock.nowMs, movingSpeedMps: null };
}

/** Waypoint ids the strip's targets name (the strip's and any field's own). */
function referencedWaypoints(strip: InfoStrip, rows: readonly (readonly FieldRef[])[]): string[] {
  const ids: string[] = [];
  if (strip.target.kind === 'waypoint') ids.push(strip.target.waypointId);
  for (const row of rows) {
    for (const f of row) {
      const t = f.params.target as { kind?: string; waypointId?: string } | null | undefined;
      if (t?.kind === 'waypoint' && typeof t.waypointId === 'string') ids.push(t.waypointId);
    }
  }
  return ids;
}

/**
 * THE coordinator (mockup §8): one hook that subscribes to the union of the
 * placed fields' data deps at their own rates, and hands `compute()` one
 * {@link DepsSnapshot}. It lives in the strip leaf, so none of its ticks
 * re-render MapScreen:
 * - camera: `mapStore.mapCenter`, written once per settle (never per frame);
 *   the DEM read only for the elevation field, only for the centre;
 * - position: the fix MapScreen already re-renders for (props);
 * - heading: its own 4 Hz, 1° gated subscription, only with a heading field;
 * - course: the tracker, only with a field that can show COG;
 * - clock: 1 Hz with ETE or a recording metric, each minute with sunset or
 *   ETA, none otherwise;
 * - moving speed: the 10-minute window, fed per fix, only with ETE/ETA;
 * - tides: only with a tide field and the extension installed; the station
 *   re-resolved per ~1 km cell, its level fetched every 10 min
 *   (`useStripTides`), the fields computed on the minute clock.
 * Each tick builds one snapshot; the fields' compute() run over it (O(fields),
 * each O(1)) and only a field whose value changed re-renders (`StripField`).
 */
export function useStripSnapshot(
  strip: InfoStrip,
  rows: readonly (readonly FieldRef[])[],
  inputs: StripInputs,
): DepsSnapshot {
  const needs = useMemo(() => stripNeeds(rows), [rows]);
  const { deps } = needs;
  const wantsCamera = deps.has('camera');
  const centre = useMapStore((s) => (wantsCamera ? s.mapCenter : null));
  const followsUser = useMapStore((s) => s.followUser);
  const coordinateFormat = useSettingsStore((s) => s.coordinateFormat);
  const { location, fix, follow, recording } = inputs;
  const youAreCentre = followsUser && location !== null;
  const centreElevationM = useCenterElevation(
    deps.has('elevation') && !youAreCentre ? centre : null,
  );
  const headingDeg = useGatedHeading(deps.has('heading'));
  const course = useCourse(deps.has('course'), location);
  const { nowMs, movingSpeedMps } = useClockAndMovingSpeed(
    needs.clockMs,
    needs.movingSpeed,
    location,
  );

  // An external receiver in use: its altitude, and the fix in other datums.
  const gnssUse = useGnssStore((s) => s.use);
  const gnssFix = useGnssStore((s) => (s.use === 'external' ? s.fix : null));
  const gnssProject = useGnssStore((s) => (s.use === 'external' ? s.project : null));

  // Tide stations (#695): "nearest" to you, or to the map centre before a fix.
  const installed = useInstalledExtensions();
  const tidesOn = deps.has('ext:tides') && installed.has('tides');
  const tideParams = useMemo(() => stripStationParams(rows), [rows]);
  const tideCentre = useMapStore((s) => (tidesOn && location === null ? s.mapCenter : null));
  const tides = useStripTides(tidesOn, tideParams, location ?? tideCentre);

  const destination = useNavigationStore((s) => s.destination);
  const waypointList = useLibraryStore((s) => s.waypoints);
  const navTarget = useMemo(
    () =>
      destination === null
        ? null
        : { name: destinationName(destination, waypointList), point: destination },
    [destination, waypointList],
  );
  const refIds = referencedWaypoints(strip, rows).join('\n');
  const waypoints = useMemo(() => {
    const out: Record<string, { name: string; point: LatLng }> = {};
    if (refIds === '') return out;
    const wanted = new Set(refIds.split('\n'));
    for (const w of waypointList) {
      if (wanted.has(w.id)) out[w.id] = { name: w.label, point: w };
    }
    return out;
  }, [refIds, waypointList]);

  return useMemo((): DepsSnapshot => {
    const external = gnssUse === 'external' && gnssFix !== null;
    const position: StripFix | null =
      location === null
        ? null
        : {
            latitude: location.latitude,
            longitude: location.longitude,
            altitudeM: external ? fixAltitude(gnssFix) : (fix?.altitude ?? null),
            accuracyM: external ? (gnssFix.accuracy?.h95 ?? null) : (fix?.accuracy ?? null),
            speedMps: fix?.speed ?? null,
          };
    const readout = follow?.readout ?? null;
    const followSnap: FollowSnapshot | null =
      readout === null
        ? null
        : {
            targetKind: readout.target.kind,
            targetId: readout.target.id,
            targetName: readout.target.name,
            targetPoint: readout.target.at,
            targetDistanceM: readout.targetDistanceM,
            crossTrackM: readout.crossTrackM,
            onTrail: readout.onTrail,
          };
    const hero: HeroData | null =
      recording === null ? null : heroData(recording, location, position?.altitudeM ?? null, nowMs);
    const datums: DepsSnapshot['datums'] = {};
    if (gnssProject?.ok === true) {
      const label = gnssProject.plan.outputLabel;
      const view: DatumView = {
        label,
        tag: datumTag(label),
        centre: null,
        you: { latitude: gnssProject.value.lat, longitude: gnssProject.value.lon },
      };
      datums.project = view;
      if (view.tag === 'CSRS') datums.csrs = view;
    }
    const gnss: GnssSnapshot | null =
      gnssFix === null
        ? null
        : {
            kind: gnssFix.kind,
            ellipsoidalHeightM: gnssFix.hEll,
            heightAccuracyM: gnssFix.accuracy?.v95 ?? null,
          };
    return {
      nowMs,
      centre,
      centreElevationM,
      followsUser,
      position,
      headingDeg,
      course,
      movingSpeedMps,
      navTarget,
      follow: followSnap,
      waypoints,
      recording: hero,
      coordinateFormat,
      datums,
      gnss,
      tides,
    };
  }, [
    nowMs,
    movingSpeedMps,
    centre,
    centreElevationM,
    followsUser,
    location,
    fix,
    follow,
    recording,
    headingDeg,
    course,
    navTarget,
    waypoints,
    coordinateFormat,
    gnssUse,
    gnssFix,
    gnssProject,
    tides,
  ]);
}

function heroData(
  r: NonNullable<StripInputs['recording']>,
  position: LatLng | null,
  altitudeM: number | null,
  nowMs: number,
): HeroData {
  return {
    elapsedS: r.elapsedS,
    distanceM: r.stats.distanceM,
    ascentM: r.stats.ascentM,
    descentM: r.stats.descentM,
    movingTimeS: r.stats.movingTimeS,
    avgSpeedMps: r.stats.avgSpeedMps,
    liveSpeedMps: r.liveSpeedMps,
    altitudeM,
    position,
    nowMs,
  };
}
