import { parseGpx } from '@core/geo/gpx';
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
 * loaded here; geometry outside the page is clipped by the composer, so the
 * only cost of loading a track that misses the region is the parse.
 */
export async function makeMap(
  bbox: BoundingBox,
  options: MakeMapOptions,
  onProgress: (phase: ComposePhase, frac: number) => void,
  handle: ComposeHandle,
): Promise<MapDocument> {
  const lib = useLibraryStore.getState();

  const tracks: ComposeInput['tracks'] = [];
  if (options.includeUserData) {
    for (const summary of lib.tracks) {
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
  const waypoints: ComposeInput['waypoints'] = lib.waypoints.map((w, i) => {
    const n = /(\d+)\s*$/.exec(w.label)?.[1];
    return { index: n ? Number(n) : i + 1, pos: [w.longitude, w.latitude] as LngLat };
  });

  // Magnetic declination for the compass rose, straight off the device
  // compass (the OS runs the real geomagnetic model): true − magnetic
  // heading, normalized to ±180. Unavailable (emulator, no sensor, compass
  // off) degrades to a true-north-only rose.
  let declinationDeg: number | null = null;
  if (options.compass) {
    try {
      const heading = await Location.getHeadingAsync();
      if (heading.trueHeading >= 0 && heading.magHeading >= 0) {
        const d = heading.trueHeading - heading.magHeading;
        declinationDeg = ((d + 540) % 360) - 180;
      }
    } catch {
      // No compass — omit the magnetic arrow.
    }
  }

  const bytes = await composeMapPdf(
    { bbox, options: { ...options, declinationDeg }, tracks, waypoints },
    onProgress,
    handle,
  );
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
  if (doc.georeferences.length === 0) {
    reportError(
      new Error('made map parsed with no georeference'),
      `made-map-georef ${JSON.stringify(options)}`,
    );
  }
  useLibraryStore.getState().addMap(doc);
  return doc;
}
