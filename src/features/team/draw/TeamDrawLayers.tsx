/**
 * The team's drawings on the main map (#683): one GeoJSON source fed by the
 * core's `drawFeatures`, six fixed layers (`@core/teamdraw/mapStyle`), each
 * at its own live anchor (`LIVE_LAYER_ORDER`: over the trails, under the
 * flag, pins and teammates).
 *
 * A MapView child of its own that subscribes to what it draws: teammates'
 * strokes arrive four times a second and must re-render this, never the map
 * screen. The source is rebuilt only when the quantised frame changes
 * (`frameKey`); the fade wakes at the core's `nextChangeAt` (at least 1 s
 * apart) and not at all while nothing fades or expires.
 */
import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import { drawFeatures, frameKey } from '@core/teamdraw/features';
import { nextChangeAt, tickDelayMs } from '@core/teamdraw/fade';
import { DRAW_LAYERS, DRAW_SOURCE, drawLayerStyles } from '@core/teamdraw/mapStyle';
import { smoothShapes } from '@core/teamdraw/smooth';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { teamLabelFont } from '@features/team/map/TeamMapLayers';
import { GeoJSONSource, Images, type ImageEntry, Layer } from '@maplibre/maplibre-react-native';
import { useTeamDrawStore } from '@state/teamDrawStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { drawMapColors } from '@ui/teamDrawTokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'react-native-paper';

import { DRAW_IMAGES } from './drawImages';

/** Source rebuilds, for the render-budget tests (measure, don't assert). */
export const drawLayerStats = { builds: 0, ticks: 0 };

const IMAGES: Record<string, ImageEntry> = Object.fromEntries(
  Object.entries(DRAW_IMAGES).map(([name, source]) => [name, { source, sdf: true }]),
);

/** The drawing clock: the replica's HLC, never behind the phone's. */
function drawNow(): number {
  return teamService()?.active?.draw.clock() ?? Date.now();
}

export function TeamDrawLayers({
  glyphs,
  zoom,
}: {
  glyphs: string | undefined;
  /** The settled camera zoom (the compact-pointer switch uses its integer band). */
  zoom: number | null;
}) {
  const t = useSchemeTokens();
  const { dark } = useTheme();
  const { installedAt, show } = useExtensionPrefs('team');
  const shapes = useTeamStore((s) => s.drawings);
  const view = useTeamStore((s) => s.view);
  const live = useTeamDrawStore((s) => s.live);
  const selected = useTeamDrawStore((s) => s.selected);
  const [tick, setTick] = useState(0);
  const zoomBand = Math.floor(zoom ?? 15);
  // The clock, read again on a new shape or stroke and on each fade tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => drawNow(), [shapes, live, tick]);

  // The fade timer: asleep while nothing on the map is fading or expiring.
  useEffect(() => {
    const until = live.reduce<number | null>(
      (m, l) => (m === null ? l.until : Math.min(m, l.until)),
      null,
    );
    const fade = nextChangeAt(shapes, now);
    const next = fade === null ? until : until === null ? fade : Math.min(fade, until);
    const delay = tickDelayMs(next, now);
    if (delay === null) return;
    const timer = setTimeout(() => {
      drawLayerStats.ticks++;
      setTick((n) => n + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [shapes, live, now]);

  const members = view?.members;
  const opts = useMemo(() => {
    const initials = new Map((members ?? []).map((m) => [m.id, m.initials]));
    return {
      ...(view ? { me: view.me } : {}),
      ...(selected !== null ? { selected } : {}),
      initials: (id: string) => initials.get(id) ?? '?',
    };
  }, [members, view, selected]);
  const smooth = useMemo(() => smoothShapes(shapes), [shapes]);
  const visibleLive = useMemo(() => live.filter((l) => l.until > now), [live, now]);
  // Rebuilt only when the quantised frame changes (one source update).
  const key = frameKey(shapes, visibleLive, now, zoomBand, opts);
  const data = useMemo(
    () => drawFeatures(smooth, visibleLive, now, zoomBand, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  useEffect(() => {
    drawLayerStats.builds++;
  }, [data]);

  const font = teamLabelFont(glyphs);
  const fontKey = font?.join('|') ?? '';
  const layers = useMemo(() => {
    const fonts = fontKey === '' ? [] : fontKey.split('|');
    const st = drawLayerStyles(drawMapColors(t, dark), selected, fonts);
    const layer = (id: keyof typeof DRAW_LAYERS, type: 'fill' | 'line' | 'symbol') => (
      <Layer
        key={id}
        id={DRAW_LAYERS[id]}
        beforeId={liveLayerAnchor(DRAW_LAYERS[id])}
        type={type}
        filter={st[id].filter as never}
        {...(st[id].layout ? { layout: st[id].layout as never } : {})}
        paint={st[id].paint as never}
      />
    );
    return [
      layer('fill', 'fill'),
      layer('casing', 'line'),
      layer('line', 'line'),
      layer('dash', 'line'),
      layer('head', 'symbol'),
      ...(fonts.length > 0 ? [layer('sym', 'symbol')] : []),
    ];
  }, [t, dark, selected, fontKey]);

  if (installedAt === 0 || !show || view === null || data.features.length === 0) return null;
  return [
    <Images key="draw-images" images={IMAGES} />,
    <GeoJSONSource key="draw-source" id={DRAW_SOURCE} data={data as never}>
      {layers}
    </GeoJSONSource>,
  ];
}
