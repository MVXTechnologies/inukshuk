/**
 * Where the LIVE drapes slot into the map's static style (perf fix
 * 2026-08-10).
 *
 * The weather frames and the marine depth chart used to be declared inside
 * the MapLibre style JSON. That looked tidy but was the root cause of both
 * field reports: `@maplibre/maplibre-react-native` hands a changed style
 * object to native by writing the whole JSON to a temp file and assigning it
 * to `styleURL`, which makes MapLibre RELOAD THE ENTIRE STYLE — every source
 * destroyed and re-created, every tile re-requested, the vector labels and
 * coastlines dropped and re-laid-out. Measured on an iPhone 16e simulator:
 * two full style reloads per 700 ms playback tick, and (with marine mode on)
 * a self-sustaining reload storm of ~15/s.
 *
 * Both drapes are therefore mounted as MapView CHILDREN, which
 * maplibre-react-native adds to the live style incrementally (an image
 * source's url/coordinates and a geojson source's data even update in
 * place).
 *
 * ## Why ANCHOR layers rather than a shared `beforeId`
 *
 * MOUNT ORDER IS NOT Z-ORDER. `MLRNLayer.addBelow` calls
 * `style.addLayerBelow(layer, belowLayerID)`, which inserts immediately below
 * the named layer — so of two children naming the SAME anchor, the one
 * inserted LAST wins the top slot. The children are re-inserted on every
 * style reload (`MLRNMapView.setReactMapStyle` removes every source and
 * re-adds them from a hash map once the new style loads) and, before the
 * one-image-per-frame work, the weather slots also remounted on every frame.
 * Sharing one anchor between the weather field and the spot soundings
 * therefore let the colour field end up ABOVE the depth numbers — the exact
 * inversion the old style-JSON ordering guaranteed against.
 *
 * Worse, a child with NO `beforeId` goes through `MLRNLayer.add()` →
 * `style.addLayer()` = the top of the ENTIRE stack, above the PDF overlays,
 * the trail lines and the "locally downloaded only" mask. So "no anchor
 * resolved yet" was not a graceful degradation, it was an inversion.
 *
 * The style therefore carries one INVISIBLE, SOURCELESS marker layer per
 * drape slot ({@link drapeAnchorLayer}), placed by `buildOsmStyle` at the
 * exact height that slot must occupy. Each drape names its own anchor, so:
 *
 * - z-order is fixed by the STYLE, not by mount order or re-insert order;
 * - every `beforeId` is a non-empty string that exists for as long as the
 *   drape that uses it is mounted, so nothing ever falls back to "top of the
 *   stack", and `MLRNLayer.setBelowLayerID(null)` — which does
 *   `removeFromMap()` then `addBelow(mBelowLayerID!!)`, i.e. a
 *   KotlinNullPointerException — is unreachable;
 * - the anchors sit below `downloaded-mask`, so offline-only mode keeps
 *   masking undownloaded ground.
 *
 * Bottom → top the live stack is:
 *   … marine drape … marine WMS seamarks … weather dim … weather A/B …
 *   spot soundings … water outlines … town labels … city labels … mask.
 */

/** Invisible marker the client-rendered depth-band drape draws under. */
export const MARINE_DRAPE_ANCHOR = 'drape-marine-chart';
/** Invisible marker the weather crossfade slots draw under. */
export const WEATHER_DRAPE_ANCHOR = 'drape-weather';
/** Invisible marker the spot soundings draw under (above the weather field). */
export const MARINE_SOUNDINGS_ANCHOR = 'drape-soundings';

/**
 * The anchors in the order `buildOsmStyle` must emit them, bottom first.
 * Every live drape anchors against exactly one of these.
 */
export const DRAPE_ANCHORS_BOTTOM_TO_TOP = [
  MARINE_DRAPE_ANCHOR,
  WEATHER_DRAPE_ANCHOR,
  MARINE_SOUNDINGS_ANCHOR,
] as const;

export type DrapeAnchorId = (typeof DRAPE_ANCHORS_BOTTOM_TO_TOP)[number];

/** An anchor as it appears in the style JSON. */
export interface DrapeAnchorLayer {
  id: DrapeAnchorId;
  type: 'background';
  layout: { visibility: 'none' };
}

/**
 * The style-JSON layer for one anchor: a `background` layer (the only type
 * needing no source) with `visibility: none`, so it reserves a position in
 * the layer list and costs nothing to render. A hidden layer is still a
 * layer, so `MLRNMapView.waitForLayer` finds it immediately and
 * `style.addLayerBelow` accepts it.
 */
export function drapeAnchorLayer(id: DrapeAnchorId): DrapeAnchorLayer {
  return { id, type: 'background', layout: { visibility: 'none' } };
}
