/**
 * Build-time feature flags — THE parking lot.
 *
 * A flag here is not a user setting and not a remote config: it is a constant
 * the owner flips when a feature is (or is not) ready to be in front of
 * users. Nothing reads it from storage, nothing writes it, and no UI exposes
 * it. Flip the constant, rebuild, and the feature is back in full.
 *
 * ## Contract for a parked feature
 *
 * 1. **The entry point stays visible but disabled.** The Weather and Marine
 *    rows in the map's Overlays menu remain in the list, greyed, with a
 *    "Coming soon" subtitle. A feature that vanishes reads as a bug or a lost
 *    purchase; a feature that is visibly deliberate reads as a roadmap.
 * 2. **Every other surface is hidden**, so nothing points at a dead feature:
 *    the drapes, legends, scrubber, model sheet, forecast/tide card, point
 *    readout lines, wind-particle overlay and its Settings switch, the
 *    marine chart, disclaimer chip, depth legend, pack banner and the
 *    Settings → Data → offline marine packs section, the weather-compare
 *    route, and the weather/marine data credits.
 * 3. **No network traffic.** Parking is meant to stop the load, not just the
 *    pixels. Every fetch these features make hangs off a hook whose enable
 *    argument is computed from these flags in `MapScreen`, so with the flags
 *    off no GeoMet capabilities/GetMap call, no CHS tide or NONNA depth call,
 *    no marine tile or pack download, and no OpenFreeMap label-tile fetch can
 *    be issued.
 * 4. **Nothing is deleted.** The implementations, their unit tests and the
 *    persisted settings all stay. A user who had Wind on gets Wind back the
 *    moment the flag flips — `settingsStore.weatherLayer` /
 *    `settingsStore.marineLayers` are never rewritten by the parking.
 *
 * The types are widened to `boolean` on purpose. With the literal types TS
 * would narrow the guarded branches to `never` and stop type-checking the
 * parked code paths — exactly the code that must still compile if flipping a
 * flag is to be a one-line change.
 */

/**
 * Weather overlays (ECCC GeoMet drapes, timeline scrubber, model sheet, wind
 * particles, forecast + tides card, weather compare).
 *
 * PARKED — owner call, 2026-09: "I think we might want to park the weather
 * features. grey it out for the next release." The feature works but has not
 * had its polish pass, so it ships greyed rather than half-finished.
 *
 * To un-park: set this to `true`. That alone restores every weather surface
 * and its network traffic. Before flipping, re-run the parked Maestro flows
 * (`.maestro/weather.yaml`, `weather-models.yaml`, `weather-wind.yaml`) and
 * the wind-particle pixel gate (`npm run wind:motion`, which self-skips while
 * this is `false`), and drop the parked-row assertions from
 * `.maestro/map-overlays.yaml`.
 */
export const WEATHER_ENABLED: boolean = false;

/**
 * Marine chart mode (NONNA/ENC depth bands, seamarks, soundings, depth
 * legend, tap-for-depth, the disclaimer chip and offline marine packs).
 *
 * PARKED — owner call, 2026-09: "grey out the marine too, the marine maps do
 * not meet the requirements and quality required and rapidity of upload yet."
 * Two separate bars, and BOTH must be cleared before this flips:
 *   - chart quality: the worldwide bathymetry ladder still degrades to coarse
 *     sources over much of the coast, which is not a chart a boater should
 *     navigate by; and
 *   - upload/fetch speed: the depth-grid fetch and the client-side band
 *     render are too slow to feel like a map.
 *
 * To un-park: set this to `true`, then re-run `.maestro/marine.yaml` and drop
 * the parked-row assertions from `.maestro/map-overlays.yaml`.
 */
export const MARINE_ENABLED: boolean = false;

/**
 * Vector "Stone & Paper" base map (`@core/map/stoneStyle`) for the `map`
 * basemap, from our own Protomaps tiles on Cloudflare (`@data/basemapTiles`,
 * `infra/tiles/`): Atkinson labels, served contour lines, vector offline
 * packs. Relief and satellite stay raster.
 *
 * ON since 2.0.0 (owner go, 2026-09-28). Flipping it off returns the OSM
 * raster (and raster offline packs, which the OSM tile policy forbids).
 */
export const VECTOR_BASEMAP_ENABLED: boolean = true;

/**
 * The once-a-year "Would you chip in?" card in the Library (#476, rules in
 * `@core/support/nudge`: ≥ 10 outings recorded this year, at most once per
 * 12 months). The Support screen and its Settings row do not depend on it.
 *
 * OFF — owner call pending (2026-09-30): the card is built and tested, but
 * whether the app should ever ask unprompted is the owner's decision. Flip to
 * `true` to show it; nothing else changes.
 */
export const SUPPORT_NUDGE_ENABLED: boolean = false;

/**
 * Reloading contour tiles the map failed to load (`@core/map/contourRecovery`,
 * `useContourRecovery`): when a visible contour tile draws nothing although
 * the server has lines for it, the contour layers blink off and on once so
 * MapLibre asks for it again. Bounded (3 fetches, 2 reloads a tile) and only
 * at zoom ≥ 10 on an untilted map.
 *
 * ON, but not yet seen on a device (2026-10-02): the reload hides the lines
 * for ~150 ms. If that blink reads badly on a phone, flip this to `false` —
 * holes then stay until the user pans away and back, as before.
 */
export const CONTOUR_RECOVERY_ENABLED: boolean = true;

/**
 * Subtitle + a11y suffix shown on a parked row in the Overlays menu. One
 * constant so the menu copy and the e2e matchers can never drift apart.
 */
export const PARKED_LABEL = 'Coming soon';
