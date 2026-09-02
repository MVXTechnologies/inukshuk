/**
 * The GeoTIFF key directory (tag 34735) — where a TIFF says which CRS it is in.
 *
 * The directory is a flat SHORT array: a four-value header
 * `[version, revision, minorRevision, keyCount]` followed by four values per
 * key — `[keyId, tagLocation, count, valueOffset]`. `tagLocation === 0` means
 * the key's value IS `valueOffset`; otherwise it indexes into the ASCII (34737)
 * or DOUBLE (34736) parameter tag.
 *
 * NRCan's CanMatrix scans carry exactly one key that matters:
 * `3072 ProjectedCSTypeGeoKey = 269xx` — NAD83 / UTM zone N. Verified on
 * 021L14 (26919), 031G05 (26918), 095J01 (26910) and 103I09 (26909).
 */
import {
  readTiffAscii,
  readTiffValues,
  type TiffEntry,
  type TiffWindow,
} from '@core/geo/tiff/container';

/** Tag holding the key directory itself. */
export const TAG_GEO_KEY_DIRECTORY = 34735;
/** Tag holding the DOUBLE parameters keys can point into. */
export const TAG_GEO_DOUBLE_PARAMS = 34736;
/** Tag holding the ASCII parameters (citations) keys can point into. */
export const TAG_GEO_ASCII_PARAMS = 34737;

/** GeoKey ids we act on. */
export const KEY_GT_MODEL_TYPE = 1024;
export const KEY_GEOGRAPHIC_TYPE = 2048;
export const KEY_PROJECTED_CS_TYPE = 3072;

/** "user-defined" and "undefined" sentinels — never real EPSG codes. */
const USER_DEFINED = 32767;
const UNDEFINED = 0;

/** What the key directory told us. Every field is optional: scans lie. */
export interface GeoKeys {
  /** 1 = projected, 2 = geographic, 3 = geocentric. */
  modelType?: number;
  /** EPSG of the projected CRS (3072), when the file names a real one. */
  projectedEpsg?: number;
  /** EPSG of the geographic CRS (2048), when the file names a real one. */
  geographicEpsg?: number;
  /** Concatenated citation text (GTCitation + GeogCitation + PCSCitation). */
  citation?: string;
}

function realEpsg(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === USER_DEFINED || value === UNDEFINED) return undefined;
  if (!Number.isInteger(value) || value < 1024 || value > 32766) return undefined;
  return value;
}

/**
 * Parse the key directory out of an IFD. Returns an empty object (never null)
 * when the tag is absent or malformed — a TIFF with no GeoTIFF keys is a
 * perfectly valid TIFF, just not a georeferenced one.
 */
export function readGeoKeys(win: TiffWindow, entries: ReadonlyMap<number, TiffEntry>): GeoKeys {
  const dirEntry = entries.get(TAG_GEO_KEY_DIRECTORY);
  if (dirEntry === undefined) return {};
  const dir = readTiffValues(win, dirEntry);
  if (dir === null || dir.length < 4) return {};
  const keyCount = dir[3] ?? 0;
  if (keyCount < 0 || 4 + keyCount * 4 > dir.length) return {};

  const asciiEntry = entries.get(TAG_GEO_ASCII_PARAMS);
  const ascii = asciiEntry !== undefined ? readTiffAscii(win, asciiEntry) : null;

  const values = new Map<number, number>();
  const citations: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    const at = 4 + i * 4;
    const keyId = dir[at];
    const location = dir[at + 1];
    const count = dir[at + 2];
    const offset = dir[at + 3];
    if (keyId === undefined || location === undefined) continue;
    if (count === undefined || offset === undefined) continue;
    if (location === 0) {
      values.set(keyId, offset);
      continue;
    }
    if (location === TAG_GEO_ASCII_PARAMS && ascii !== null) {
      // ASCII keys are `offset`..`offset+count` into the citation blob; the
      // trailing "|" separator is part of the count, so trim it.
      const text = ascii
        .slice(offset, offset + count)
        .replace(/\|+$/, '')
        .trim();
      if (text !== '') citations.push(text);
    }
    // DOUBLE-parameter keys (projection parameters for a user-defined CRS)
    // are deliberately ignored: we only support named EPSG codes, and a
    // hand-rolled projection from raw parameters would be a second, untested
    // proj4. A file like that falls through to "no EPSG" and is rejected.
  }

  const modelType = values.get(KEY_GT_MODEL_TYPE);
  const projectedEpsg = realEpsg(values.get(KEY_PROJECTED_CS_TYPE));
  const geographicEpsg = realEpsg(values.get(KEY_GEOGRAPHIC_TYPE));
  const citation = citations.length > 0 ? citations.join(' | ') : undefined;
  return {
    ...(modelType !== undefined ? { modelType } : {}),
    ...(projectedEpsg !== undefined ? { projectedEpsg } : {}),
    ...(geographicEpsg !== undefined ? { geographicEpsg } : {}),
    ...(citation !== undefined ? { citation } : {}),
  };
}

/**
 * The EPSG code to reproject from: the projected CRS when there is one (the
 * raster's coordinates are then in its linear units), else the geographic one.
 */
export function epsgFromGeoKeys(keys: GeoKeys): number | undefined {
  return keys.projectedEpsg ?? keys.geographicEpsg;
}
