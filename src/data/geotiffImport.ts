/**
 * Landing a CanMatrix GeoTIFF in the maps store.
 *
 * NRCan's scanned 1:50k sheets are ~30 MB zips holding ~92 MB of uncompressed
 * 8-bit palette raster. Neither number can sit in a phone's JS heap, and the
 * app has no use for the full-resolution scan afterwards — the map overlay is
 * an `ImageSource` a couple of thousand pixels across. So the import turns the
 * sheet into its overlay **once**, at download time, and stores the PNG as the
 * map file. Nothing else in the app changes: the library holds a
 * {@link MapDocument} whose `fileUri` happens to end in `.png`, and the overlay
 * hook draws it directly instead of running the PDF rasterizer.
 *
 * The read never buffers the sheet. The zip entry is inflated twice through
 * `@core/geo/geotiff/stream` — once for the ~67 KB header window, once to lift
 * out only the ~1 500 image rows the downscale plan samples. Peak allocation is
 * the output bitmap (about 12 MB of RGBA at 2 048 px across), not the file.
 *
 * **What we give up.** The full-resolution scan is discarded, so the overlay
 * cannot later be re-rendered sharper the way an imported GeoPDF can. That is
 * the deliberate trade: keeping the source would cost ~92 MB per sheet on a
 * device whose whole point is carrying a lot of sheets offline.
 */
import { Unzip, UnzipInflate } from 'fflate';
import UPNG from 'upng-js';

import { isTiffEntryName, looksLikeTiff } from '@core/catalog/unzip';
import { makeReprojector } from '@core/geo/geopdf/crs';
import { rasterGeoReference } from '@core/geo/geotiff/georeference';
import {
  cropForPolygon,
  densifyBboxRing,
  maskRgbaOutsidePolygon,
  projectRingToPixels,
  type PixelPoint,
} from '@core/geo/geotiff/neatline';
import {
  decodeRasterRowToRgba,
  fullRasterCrop,
  planRasterDownscale,
  rasterRowByteRange,
  type RasterCrop,
  type RasterGeoTiff,
} from '@core/geo/geotiff/rasterTiff';
import { createStreamRangeExtractor, createTiffHeaderCollector } from '@core/geo/geotiff/stream';
import type { BoundingBox, GeoReference } from '@core/models';
import * as storage from './storage';

/**
 * Overlay width the sheet is rendered to. Matches the PDF overlay's
 * `OVERLAY_TARGET_WIDTH_PX`, so both kinds of map cost the same to draw and a
 * GeoTIFF sheet is no sharper or blurrier than a GeoPDF one beside it.
 */
export const GEOTIFF_OVERLAY_WIDTH_PX = 2048;

/** Bytes per read from the staged download. Big enough to keep inflate busy. */
const STREAM_CHUNK_BYTES = 1 << 20;

export interface GeoTiffImportResult {
  /** `file://` uri of the rendered PNG in the maps store. */
  fileUri: string;
  georeference: GeoReference;
  /** Rendered overlay size in pixels. */
  widthPx: number;
  heightPx: number;
}

/** Thrown when the file is not a GeoTIFF this client can draw. */
export class GeoTiffImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoTiffImportError';
  }
}

/**
 * Thrown when the caller's `shouldAbort` went true part-way through. The
 * render is long enough that a user can hit Cancel in the middle of it, and
 * finishing anyway would install a map they said they did not want.
 */
export class GeoTiffImportAborted extends Error {
  constructor() {
    super('GeoTIFF import aborted');
    this.name = 'GeoTiffImportAborted';
  }
}

/**
 * Stream the TIFF bytes of `uri` through `onChunk`, in file order.
 *
 * The staged file is normally a zip (CanMatrix ships that way) but may be a
 * bare TIFF — some mirrors serve one, and a user-picked file certainly is. The
 * first chunk decides, by magic number rather than by file name.
 */
async function streamTiffBytes(
  uri: string,
  onChunk: (chunk: Uint8Array) => void,
  onProgress?: (fraction: number) => void,
  shouldAbort?: () => boolean,
): Promise<void> {
  let unzipper: Unzip | null = null;
  let decided = false;
  let raw = false;
  let matchedEntry = false;
  // Collected rather than assigned to a captured `let`: an inflate error must
  // survive the callback and abort the import, not be swallowed mid-stream.
  const inflateErrors: Error[] = [];

  await storage.readFileChunksYielding(
    uri,
    STREAM_CHUNK_BYTES,
    (chunk, final) => {
      // Checked per chunk (~1 MB): the loop yields between chunks, so this is
      // where a Cancel tapped mid-render actually takes effect.
      if (shouldAbort?.() === true) throw new GeoTiffImportAborted();
      if (!decided) {
        decided = true;
        raw = looksLikeTiff(chunk);
        if (!raw) {
          const uz = new Unzip();
          uz.register(UnzipInflate);
          uz.onfile = (file) => {
            // First .tif entry only: these archives hold the sheet plus an XML
            // metadata sidecar, and starting a second entry would interleave
            // two files into one stream.
            if (matchedEntry || !isTiffEntryName(file.name)) return;
            matchedEntry = true;
            file.ondata = (err, data) => {
              if (err !== null) inflateErrors.push(err);
              if (data.length > 0) onChunk(data);
            };
            file.start();
          };
          unzipper = uz;
        }
      }
      if (raw) {
        onChunk(chunk);
        return;
      }
      unzipper?.push(chunk, final);
    },
    onProgress,
  );

  const inflateFailure = inflateErrors[0];
  if (inflateFailure !== undefined) {
    throw new GeoTiffImportError(`The downloaded archive is damaged: ${inflateFailure.message}`);
  }
  if (!raw && !matchedEntry) {
    throw new GeoTiffImportError('The downloaded file contains no GeoTIFF map.');
  }
}

/**
 * The crop to render: the sheet's neatline when the caller knows where the
 * map frame is, else the whole scan.
 *
 * A CanMatrix scan is the whole printed sheet — legend panel, marginalia and
 * all — georeferenced across its full extent, so drawing it raw covers several
 * kilometres of the neighbouring sheet with paper. `clipBbox` is the sheet's
 * own graticule quad (the catalog carries it, from NRCan's sheet index); it is
 * projected into the raster's grid, used as the crop, and anything still
 * outside it is made transparent so adjacent sheets tile cleanly.
 */
function planCrop(
  raster: RasterGeoTiff,
  reprojector: ReturnType<typeof makeReprojector>,
  clipBbox: BoundingBox | undefined,
): { crop: RasterCrop; polygon: PixelPoint[] } {
  if (clipBbox === undefined) return { crop: fullRasterCrop(raster), polygon: [] };
  const polygon = projectRingToPixels(raster.model, reprojector, densifyBboxRing(clipBbox));
  const crop = cropForPolygon(polygon, raster.width, raster.height);
  // A crop the guard rejected means the clip and the file disagree about where
  // this sheet is. Draw the whole scan rather than a sliver of it.
  if (crop === null) return { crop: fullRasterCrop(raster), polygon: [] };
  return { crop, polygon };
}

/**
 * Read the GeoTIFF staged at `stagedUri`, render its overlay, and write it to
 * `maps/<mapId>.png`. Throws {@link GeoTiffImportError} for a file this client
 * cannot draw; the caller owns deleting the staged download either way.
 *
 * `onRenderProgress` gets 0..1 across both passes — the render takes as long as
 * the download did, and a bar that sits at 100% for half a minute reads as a
 * hang.
 */
export async function installGeoTiffMap(
  stagedUri: string,
  mapId: string,
  options: {
    clipBbox?: BoundingBox;
    targetWidthPx?: number;
    onRenderProgress?: (fraction: number) => void;
    /** Polled between chunks; true makes the import throw {@link GeoTiffImportAborted}. */
    shouldAbort?: () => boolean;
  } = {},
): Promise<GeoTiffImportResult> {
  const report = options.onRenderProgress;
  const { shouldAbort } = options;
  // Pass 1 — the header. Everything before the image file directory is fed
  // through and dropped; only the directory and the tables it points at are
  // kept (~67 KB of a 92 MB sheet).
  const collector = createTiffHeaderCollector();
  await streamTiffBytes(
    stagedUri,
    (chunk) => collector.push(chunk),
    report === undefined ? undefined : (f) => report(f * 0.5),
    shouldAbort,
  );
  const { raster, warnings } = collector.finish();
  if (raster === null) {
    throw new GeoTiffImportError(
      warnings[0] ?? 'This GeoTIFF is not in a format this app can draw.',
    );
  }

  const reprojector = makeReprojector(raster.epsg !== undefined ? { epsg: raster.epsg } : {});
  const { crop, polygon } = planCrop(raster, reprojector, options.clipBbox);
  const georeference = rasterGeoReference(raster.model, crop, reprojector, {
    ...(raster.epsg !== undefined ? { sourceEpsg: raster.epsg } : {}),
  });
  if (georeference === null) {
    throw new GeoTiffImportError('This GeoTIFF’s georeferencing does not land on the globe.');
  }

  const plan = planRasterDownscale(crop, options.targetWidthPx ?? GEOTIFF_OVERLAY_WIDTH_PX);
  if (plan === null) throw new GeoTiffImportError('This GeoTIFF has no drawable pixels.');

  // Pass 2 — the pixels. The plan samples ascending rows, and an uncompressed
  // single-plane raster puts each row in a known byte range, so the rows can be
  // lifted straight out of the inflate stream one at a time.
  const rgba = new Uint8Array(plan.outWidth * plan.outHeight * 4);
  const ranges: { offset: number; length: number }[] = [];
  const rowForRange: number[] = [];
  for (let j = 0; j < plan.outHeight; j++) {
    const row = plan.srcRows[j];
    if (row === undefined) continue;
    const range = rasterRowByteRange(raster, row);
    if (range === null) continue;
    ranges.push(range);
    rowForRange.push(j);
  }
  const extractor = createStreamRangeExtractor(ranges, (index, bytes) => {
    const outRow = rowForRange[index];
    if (outRow !== undefined) decodeRasterRowToRgba(raster, plan, bytes, outRow, rgba);
  });
  await streamTiffBytes(
    stagedUri,
    (chunk) => extractor.push(chunk),
    report === undefined ? undefined : (f) => report(0.5 + f * 0.5),
    shouldAbort,
  );

  if (polygon.length > 0) maskRgbaOutsidePolygon(rgba, plan, polygon);

  const png = new Uint8Array(
    UPNG.encode([rgba.buffer as ArrayBuffer], plan.outWidth, plan.outHeight, 0),
  );
  const fileUri = storage.writeMapBytes(mapId, png, 'png');
  return { fileUri, georeference, widthPx: plan.outWidth, heightPx: plan.outHeight };
}
