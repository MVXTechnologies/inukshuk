import type { BoundingBox, LngLat } from './geo';

/**
 * The four geographic corners of a rectangular raster, in WGS84.
 *
 * Order matches MapLibre's `ImageSource.coordinates`: top-left, top-right,
 * bottom-right, bottom-left (clockwise starting at the top-left). "Top" means
 * the visual top of the rendered page image.
 */
export interface CornerCoordinates {
  topLeft: LngLat;
  topRight: LngLat;
  bottomRight: LngLat;
  bottomLeft: LngLat;
}

/** A rectangle in PDF user-space points. Origin is the page's bottom-left. */
export interface PointRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Which mechanism produced the georeferencing, best→worst trust order. */
export type GeoReferenceSource =
  | 'adobe-geo' // ISO 32000 Measure/GEO viewport dictionary
  | 'lgidict' // OGC Best Practice / TerraGo LGIDict
  | 'world-file' // sidecar .pgw / .pdfw world file
  | 'aux-xml' // sidecar .aux.xml (GDAL)
  | 'manual'; // user-placed control points

/**
 * Resolved georeferencing for a single PDF page.
 *
 * `viewport.corners` are the geographic corners of the *map frame* (the neatline
 * / viewport rectangle), which may be a sub-rectangle of the page. `viewport.rect`
 * is that same rectangle expressed in PDF points so the overlay layer can map a
 * full-page render onto the map (see geomath.extrapolatePageCorners).
 */
export interface GeoReference {
  pageIndex: number;
  source: GeoReferenceSource;
  /** EPSG code of the PDF's native CRS, if identified (e.g. 4326, 3857, 32618). */
  sourceEpsg?: number;
  /**
   * Human-readable native CRS ("NAD83 / UTM zone 19N (EPSG:26919)"), as the
   * PDF spelled it. Present whether or not we could reproject it, so a sheet we
   * cannot place can *name* the projection it is in — on the Library card and
   * in the error report — instead of failing silently (#243). Absent on
   * documents imported before that fix.
   */
  sourceCrs?: string;
  /**
   * Size of the page's *rendered* box in PDF points (1/72 inch) — the
   * CropBox ∩ MediaBox that pdf.js and the native renderers draw, which is
   * what the overlay raster's pixels span (see {@link pageBox}). Documents
   * imported before #287 recorded the MediaBox size here instead.
   */
  pageWidthPt: number;
  pageHeightPt: number;
  /**
   * The rendered page box in PDF user space, origin included: CropBox ∩
   * MediaBox, or the MediaBox when there is no usable CropBox. `viewport.rect`
   * is expressed in the same user space, so placing the raster means mapping
   * the viewport's corners onto *this* rectangle — not onto
   * `[0, 0, pageWidthPt, pageHeightPt]`, which silently assumed a zero-origin
   * MediaBox and drew cropped or offset pages at twice their extent (#287).
   *
   * Absent on documents imported before #287: those keep the old
   * zero-origin-MediaBox placement (right for the vast majority of sheets)
   * and are flagged for re-import by `needsPageBoxReprocessing`.
   */
  pageBox?: PointRect;
  viewport: {
    /** Map-frame rectangle in PDF points (origin bottom-left). */
    rect: PointRect;
    /** Geographic corners of that rectangle, in WGS84. */
    corners: CornerCoordinates;
  };
  /** WGS84 bbox of the viewport corners — used for fitBounds and inside tests. */
  bbox: BoundingBox;
}
