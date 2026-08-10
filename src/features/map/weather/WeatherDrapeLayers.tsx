import { drapeSourceId, WEATHER_DRAPE_ANCHOR } from '@core/geo/mapLayerStack';
import type { WeatherCrossfadeState } from '@core/weather/weatherCrossfade';
import { Layer, RasterSource } from '@maplibre/maplibre-react-native';

/**
 * The weather drape's two crossfade slots, mounted as MapView CHILDREN
 * instead of style-JSON layers (perf fix 2026-08-10, owner: "animations when
 * pressing play for weather are still very laggy… the lines disappear and the
 * colors disappear and then they reappear").
 *
 * Why children: handing `<Map mapStyle>` a new style object makes
 * maplibre-react-native serialise the whole style to a temp file and assign
 * it to the native `styleURL`, which RELOADS THE ENTIRE STYLE — every source
 * torn down and refetched, the vector coastlines and labels dropped and
 * rebuilt. With the frames in the style that happened TWICE per 700 ms
 * playback tick (measured), which is exactly the blink the owner sees. As
 * children only the slot that actually changed is touched.
 *
 * The A/B contract is unchanged (`@core/weather/weatherCrossfade`): the
 * incoming frame mounts in the idle slot at opacity 0 — MapLibre fetches
 * tiles for an invisible layer, so that IS the prefetch — and the commit is
 * a pure paint update on both layers, which maplibre applies in place. The
 * visible slot is never unmounted while a frame is staged, so a swap itself
 * never blanks the drape.
 *
 * Source ids are hashed from the frame URL: MapLibre cannot re-point a tile
 * source, so a new frame remounts its slot, and `MLRNSource.addToMap` reuses
 * any source that still carries the same identifier (which would silently
 * pin the outgoing frame's tiles). That remount is also why both slots
 * anchor on their OWN marker layer ({@link WEATHER_DRAPE_ANCHOR}) rather
 * than on a layer they share with the soundings: a re-insert below a shared
 * anchor takes the top slot, so from frame 2 the colour field would have
 * buried the depth numbers (see `@core/geo/mapLayerStack`).
 */
export function WeatherDrapeLayers({
  fade,
  opacity,
  attribution,
}: {
  fade: WeatherCrossfadeState;
  opacity: number;
  attribution: string;
}) {
  return (
    <>
      {([0, 1] as const).map((slot) => {
        const url = fade.slots[slot];
        if (url === null) return null;
        const id = drapeSourceId(slot === 0 ? 'weather-a' : 'weather-b', url);
        return (
          <RasterSource key={id} id={id} tiles={[url]} tileSize={256} attribution={attribution}>
            <Layer
              id={`${id}-layer`}
              type="raster"
              beforeId={WEATHER_DRAPE_ANCHOR}
              paint={{
                'raster-opacity': slot === fade.activeSlot ? opacity : 0,
                // MapLibre animates paint changes over a 300 ms default
                // transition. On an opacity swap that means BOTH slots sit
                // part-transparent for a third of a second and the muted
                // basemap grins through — measured as a washed-out frame in
                // ~1 screenshot in 4 during playback, i.e. a visible pulse
                // every tick. The swap is already gated on the incoming
                // frame being drawn, so it wants to be a hard cut.
                'raster-opacity-transition': { duration: 0, delay: 0 },
                // Per-tile fades would smear consecutive radar frames into
                // each other; the swap itself is covered by the preload.
                'raster-fade-duration': 0,
              }}
            />
          </RasterSource>
        );
      })}
    </>
  );
}
