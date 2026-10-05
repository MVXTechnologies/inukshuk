/**
 * The style the native 3D terrain drapes on its mesh ("Match Outmap", #551):
 * the live 2D map style, rendered per terrain tile by MapLibre's own
 * offscreen renderer into a mip-mapped texture. Forests, water, glaciers,
 * contours, trails, hillshade and PDF overlays come out exactly as the 2D map
 * paints them; names do not — they are the scene's 3D pins instead.
 *
 * Pure: the hook serialises the result and the native side only re-renders
 * its drapes when this JSON actually changes.
 */

/** The parts of a MapLibre style this transform reads (structural, no SDK import). */
export interface DrapeStyleLayer {
  id: string;
  type: string;
  minzoom?: number;
  maxzoom?: number;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DrapeStyleInput {
  layers: readonly DrapeStyleLayer[];
  [key: string]: unknown;
}

export interface DrapeStyleOptions {
  /** Layers dropped whatever their type (e.g. the 2D tilt-relief pass). */
  dropLayerIds?: readonly string[];
  /**
   * The flat hillshade layer: in the drape it shades every zoom the terrain
   * shows (its 2D zoom gate only exists to save DEM traffic on a flat map).
   */
  hillshadeLayerId?: string;
  /** The lowest zoom the drape's hillshade draws from. */
  hillshadeMinZoom?: number;
  /**
   * Multiplier on the hillshade's settled exaggeration (capped at 1): seen
   * obliquely the 2D shading reads flatter than from above.
   */
  hillshadeBoost?: number;
  /**
   * Alpha multipliers on the hillshade's `rgba()` colours (shadow, highlight,
   * accent): the relief's contrast seen obliquely, in the theme's own colours.
   */
  hillshadeAlpha?: { shadow: number; highlight: number; accent: number };
  /** Contour line layers, softened in the drape (dense on steep 3D slopes). */
  contourLayerIds?: readonly string[];
  /** Multiplier on the contours' line-opacity (default 1). */
  contourOpacity?: number;
  /**
   * A raster-dem source whose declared tile size is lowered in the drape, so
   * the hillshade reads DEM tiles deeper than the drape's own zoom (the
   * relief's detail on a texture rendered one zoom out). 256 → 128: two zooms.
   */
  demSourceId?: string;
  demTileSize?: number;
  /**
   * The same for a raster source (the satellite imagery): declared smaller
   * in the drape so it is read deeper — 256 fills a 512 px drape texture
   * with the imagery's own pixels (2.2.1, sharper satellite in 3D).
   */
  rasterSourceId?: string;
  rasterTileSize?: number;
}

/** Default lowest zoom for the draped hillshade (tiles further out are fogged). */
export const DRAPE_HILLSHADE_MIN_ZOOM = 7;

/**
 * A constant for a zoom-ramped paint value: the last stop of an
 * `interpolate`/`step` on zoom (the drape is rendered at many zooms; the ramp
 * only exists to fade the 2D gate in), the value itself otherwise.
 */
export function settledZoomValue(v: unknown): unknown {
  if (!Array.isArray(v) || v.length < 3) return v;
  const op: unknown = v[0];
  const input: unknown = op === 'step' ? v[1] : v[2];
  const isZoom = Array.isArray(input) && input[0] === 'zoom';
  if (!isZoom || (op !== 'interpolate' && op !== 'step')) return v;
  return v[v.length - 1];
}

function mentionsZoom(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  if (v[0] === 'zoom') return true;
  return v.some(mentionsZoom);
}

/**
 * `v × f` as a valid style value: a number, a data expression wrapped in `*`,
 * or — for a top-level zoom `interpolate`/`step`, where `zoom` can't be nested —
 * each output scaled in place.
 */
export function scaleStyleValue(v: unknown, f: number): unknown {
  if (f === 1) return v;
  if (typeof v === 'number') return v * f;
  if (!Array.isArray(v)) return v;
  if (!mentionsZoom(v)) return ['*', v, f];
  const op: unknown = v[0];
  // interpolate: [op, kind, input, stop, out, stop, out…] — outputs at even i ≥ 4.
  // step: [op, input, out, stop, out…] — outputs at even i ≥ 2.
  if (op === 'interpolate' || op === 'step') {
    const firstOut = op === 'step' ? 2 : 4;
    return v.map((x: unknown, i: number) =>
      i >= firstOut && i % 2 === 0 ? scaleStyleValue(x, f) : x,
    );
  }
  return v; // a zoom expression of another shape: left as is
}

/** An `rgba(r, g, b, a)` colour with its alpha × f (capped at 1); anything else unchanged. */
export function scaleRgbaAlpha(color: unknown, f: number): unknown {
  if (typeof color !== 'string') return color;
  const m = /^rgba\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([\d.]+)\s*\)$/.exec(color.trim());
  if (!m) return color;
  const a = Math.min(1, Number(m[4]) * f);
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${Math.round(a * 1000) / 1000})`;
}

/** The draped copy of `style`: no symbol layers, no dropped ids, hillshade at every zoom. */
export function drapeStyle<S extends DrapeStyleInput>(style: S, o: DrapeStyleOptions = {}): S {
  const drop = new Set(o.dropLayerIds ?? []);
  const contours = new Set(o.contourLayerIds ?? []);
  const layers: DrapeStyleLayer[] = [];
  for (const layer of style.layers) {
    if (layer.type === 'symbol' || drop.has(layer.id)) continue;
    if (layer.layout?.visibility === 'none') continue;
    if (o.hillshadeLayerId !== undefined && layer.id === o.hillshadeLayerId) {
      const paint: Record<string, unknown> = { ...(layer.paint ?? {}) };
      if ('hillshade-exaggeration' in paint) {
        const settled = settledZoomValue(paint['hillshade-exaggeration']);
        paint['hillshade-exaggeration'] =
          typeof settled === 'number' ? Math.min(1, settled * (o.hillshadeBoost ?? 1)) : settled;
      }
      const alpha = o.hillshadeAlpha;
      if (alpha) {
        paint['hillshade-shadow-color'] = scaleRgbaAlpha(
          paint['hillshade-shadow-color'],
          alpha.shadow,
        );
        paint['hillshade-highlight-color'] = scaleRgbaAlpha(
          paint['hillshade-highlight-color'],
          alpha.highlight,
        );
        paint['hillshade-accent-color'] = scaleRgbaAlpha(
          paint['hillshade-accent-color'],
          alpha.accent,
        );
      }
      layers.push({
        ...layer,
        minzoom: Math.min(layer.minzoom ?? 0, o.hillshadeMinZoom ?? DRAPE_HILLSHADE_MIN_ZOOM),
        paint,
      });
      continue;
    }
    if (contours.has(layer.id) && (o.contourOpacity ?? 1) !== 1) {
      const paint: Record<string, unknown> = { ...(layer.paint ?? {}) };
      paint['line-opacity'] = scaleStyleValue(paint['line-opacity'] ?? 1, o.contourOpacity ?? 1);
      layers.push({ ...layer, paint });
      continue;
    }
    layers.push(layer);
  }
  const sources = style.sources;
  if (typeof sources !== 'object' || sources === null) return { ...style, layers };
  const all = sources as Record<string, Record<string, unknown>>;
  let next: Record<string, Record<string, unknown>> | null = null;
  const resize = (id: string | undefined, size: number | undefined, type: string) => {
    if (id === undefined || size === undefined) return;
    const src = all[id];
    if (src?.type !== type) return;
    next = { ...(next ?? all), [id]: { ...src, tileSize: size } };
  };
  resize(o.demSourceId, o.demTileSize, 'raster-dem');
  resize(o.rasterSourceId, o.rasterTileSize, 'raster');
  if (next !== null) return { ...style, sources: next, layers };
  return { ...style, layers };
}
