import { WEATHER_DRAPE_ANCHOR } from '@core/geo/mapLayerStack';
import type { WeatherCrossfadeState } from '@core/weather/weatherCrossfade';
import { ImageSource, Layer } from '@maplibre/maplibre-react-native';

import type { WeatherDrapeFrame } from './useWeatherDrape';

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
 * playback tick (measured), which is exactly the blink the owner saw. As
 * children only the slot that actually changed is touched.
 *
 * Why IMAGE sources (perf work 2026-08-11, owner: "can you find a method to
 * reduce the tile fetch time?"): the slots used to be WMS raster sources with
 * a `{bbox-epsg-3857}` tile template, i.e. ~15 GetMap round trips per frame
 * on a phone — measured at 1.5–2.1 s cold against 0.48–0.8 s for a single
 * viewport GetMap of the same area, for the same bytes. Each slot now draws
 * ONE pre-downloaded PNG (`useWeatherDrape` + `@data/weatherFrames`), which
 * both removes fourteen round trips and lets the next frames be warmed while
 * this one is on screen.
 *
 * The A/B contract is unchanged (`@core/weather/weatherCrossfade`): the
 * incoming frame mounts in the idle slot at opacity 0 and the commit is a
 * pure paint update on both layers, which maplibre applies in place. Source
 * ids are FIXED per slot: an ImageSource's `url` and `coordinates` update in
 * place (`MLRNImageSource.setUrl`), so unlike a tile source there is nothing
 * to remount and no stale-tile risk to hash around.
 *
 * A slot renders nothing while its frame is not in `frames` — the drape's
 * resolved-bitmap map is bounded, so eviction there has to protect exactly
 * the keys the slots hold, which is what `useWeatherDrape` does. Both slots
 * anchor on their OWN marker layer ({@link WEATHER_DRAPE_ANCHOR}) rather
 * than on one shared with the soundings: a child is inserted immediately
 * below the layer it names, so of two children sharing an anchor the one
 * re-inserted last takes the top slot and the colour field would bury the
 * depth numbers (see `@core/geo/mapLayerStack`).
 *
 * The ECCC credit rides in the app's data credits (`mapDataCredits`), not on
 * the source — an ImageSource carries no attribution field.
 */
export function WeatherDrapeLayers({
  fade,
  frames,
  opacity,
}: {
  fade: WeatherCrossfadeState;
  /** Resolved local bitmaps, keyed by the frame identity the slots carry. */
  frames: ReadonlyMap<string, WeatherDrapeFrame>;
  opacity: number;
}) {
  return (
    <>
      {([0, 1] as const).map((slot) => {
        const key = fade.slots[slot];
        if (key === null) return null;
        const frame = frames.get(key);
        if (frame === undefined) return null;
        const id = slot === 0 ? 'weather-a' : 'weather-b';
        return (
          <ImageSource key={id} id={id} url={frame.uri} coordinates={frame.coordinates}>
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
          </ImageSource>
        );
      })}
    </>
  );
}
