import { parseGpx } from '@core/geo/gpx';
import { layoutMadeMap } from '@core/mapmaker/layout';
import { resolvePointsToLoad, resolveTracksToLoad } from '@core/mapmaker/contentSelection';
import type { BoundingBox, LngLat, MapDocument } from '@core/models';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import * as Location from 'expo-location';
import { mapDocumentFromStoredPdf } from '../../library/importMap';
import {
  composeMapPdf,
  type ComposeHandle,
  type ComposeInput,
  type ComposePhase,
  type MakeMapOptions,
} from './composeMapPdf';

/**
 * Compose a made map and land it in the Library through the standard PDF
 * import path — a made map IS an imported PDF (activate/rename/folders/delete
 * all behave identically), and re-parsing our own file with `parseGeoPdf`
 * doubles as an end-to-end georeferencing check on every single make.
 *
 * Track geometries live in GPX files (the store holds summaries), so they're
 * loaded here — but ONLY for the tracks the user picked that can actually
 * reach the page (#356). This used to read and XML-parse every GPX in the
 * library on every make and let the composer's clipper discard the misses; a
 * summary already carries a bounding box, so the ones that cannot print are
 * excluded with no file I/O at all.
 *
 * Cancellation (#309): `handle.aborted` is re-checked after every await and
 * once more right before the durable `addMap`, so a Cancel that lands while
 * the composer/parse is still running rejects with 'aborted' instead of
 * saving a map nobody asked for; a PDF already written by then is deleted.
 */
export async function makeMap(
  bbox: BoundingBox,
  options: MakeMapOptions,
  onProgress: (phase: ComposePhase, frac: number) => void,
  handle: ComposeHandle,
): Promise<MapDocument> {
  const lib = useLibraryStore.getState();
  const aborted = () => new Error('aborted');

  // The page the composer will actually draw — the requested bbox expanded to
  // the sheet's aspect. Filtering against the REQUESTED bbox would drop a
  // trail that only enters the drawn margin. Computed lazily: a sheet with no
  // user data on it needs no page and no selection work at all.
  const pageBbox = () =>
    layoutMadeMap(bbox, options.format, { scaleDenom: options.scaleDenom }).drawBbox;

  const tracks: ComposeInput['tracks'] = [];
  if (options.includeUserData) {
    const page = pageBbox();
    const summaries = lib.tracks.map((t) => ({ id: t.id, bbox: t.stats.bbox }));
    const toLoad = new Set(resolveTracksToLoad(summaries, page, options.trackIds));
    for (const summary of lib.tracks) {
      if (!toLoad.has(summary.id)) continue;
      if (handle.aborted) throw aborted();
      try {
        const { points } = parseGpx(await storage.readFileText(summary.fileUri));
        tracks.push({
          name: summary.name,
          points: points.map((p): LngLat => [p.longitude, p.latitude]),
        });
      } catch {
        // A track that fails to parse just doesn't print — not fatal.
      }
    }
  }
  const wantWaypoints = options.includeUserData
    ? new Set(resolvePointsToLoad(lib.waypoints, pageBbox(), options.waypointIds))
    : new Set<string>();
  const waypoints: ComposeInput['waypoints'] = lib.waypoints
    .map((w, i) => {
      // The badge number printed beside a pin. Only an untouched auto label
      // carries a meaningful one, so match that exact shape: since waypoints
      // became renameable the label is arbitrary user text, and the old loose
      // trailing-digit match would print "2026" for a "Bivouac 2026". Anything
      // else falls back to the waypoint's position on the sheet.
      const n = /^Waypoint (\d+)$/.exec(w.label)?.[1];
      return {
        index: n ? Number(n) : i + 1,
        pos: [w.longitude, w.latitude] as LngLat,
        keep: wantWaypoints.has(w.id),
      };
    })
    // Numbering is computed over the WHOLE library first, so a pin keeps the
    // number it wears on the map even when its neighbours are left off.
    .filter((w) => w.keep)
    .map(({ index, pos }) => ({ index, pos }));

  // Magnetic declination for the compass rose, straight off the device
  // compass (the OS runs the real geomagnetic model): true − magnetic
  // heading, normalized to ±180. Unavailable (emulator, no sensor, compass
  // off) degrades to a true-north-only rose.
  let declinationDeg: number | null = null;
  if (options.compass) {
    try {
      // getHeadingAsync NEVER RESOLVES on magnetometer-less devices (it waits
      // for a reading that can't come) — race it with a short timeout or the
      // whole compose hangs at "Making…" forever.
      const heading = await Promise.race([
        Location.getHeadingAsync(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (heading && heading.trueHeading >= 0 && heading.magHeading >= 0) {
        const d = heading.trueHeading - heading.magHeading;
        declinationDeg = ((d + 540) % 360) - 180;
      }
    } catch {
      // No compass — omit the magnetic arrow.
    }
  }

  if (handle.aborted) throw aborted();

  const bytes = await composeMapPdf(
    { bbox, options: { ...options, declinationDeg }, tracks, waypoints },
    onProgress,
    handle,
  );
  if (handle.aborted) throw aborted();
  const id = storage.newId();
  const fileUri = storage.writeMapPdfBytes(id, bytes);
  let doc: MapDocument;
  try {
    doc = await mapDocumentFromStoredPdf(id, fileUri, options.name);
  } catch (err) {
    // Failing to re-parse a PDF we just wrote is a bug in the composer or
    // writer, not a user error — surface it through error reporting with the
    // recipe so it can be reproduced.
    reportError(err, `made-map-import ${JSON.stringify(options)}`);
    throw err;
  }
  if (handle.aborted) {
    // Cancelled during the re-parse: the file is on disk but was never added.
    storage.deleteFileAt(fileUri);
    throw aborted();
  }
  if (doc.georeferences.length === 0) {
    reportError(
      new Error('made map parsed with no georeference'),
      `made-map-georef ${JSON.stringify(options)}`,
    );
  }
  useLibraryStore.getState().addMap(doc);
  return doc;
}
