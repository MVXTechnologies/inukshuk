import { Directory, File, Paths } from 'expo-file-system';

import {
  normalizePackBasemap,
  packZoomRange,
  type Basemap,
  type PackBasemap,
  type PackFormat,
} from '@core/geo/tiles';
import { parseUrlTemplates, styleUrlTemplates, type UrlTemplates } from '@core/map/tileUrls';
import { isOutOfSpaceMessage } from '@core/storage/diskBudget';
import { servedFileUrl } from '@core/storage/servedPaths';
import type { BoundingBox } from '@core/models';
import { NetworkManager, OfflineManager } from '@maplibre/maplibre-react-native';

import { acquireLocalServer, type LocalServerLease } from './localServer';
import { setNetworkAllowed } from './storage';
import { clearWeatherFrames } from './weatherFrames';

// MapLibre's offline `createPack` expects `mapStyle` to be an **http(s) style URL**
// it can fetch through its native HTTP source — inline style JSON AND `file://`
// are both rejected ("Unable to parse resourceUrl …"). So during a download we
// serialize the active basemap's style to a file under Documents and hand
// MapLibre its URL on the app's shared loopback server (`./localServer`, held
// for the duration of the download). The tiles themselves stream from the real
// OSM/Esri https endpoints; only the tiny style document needs a local http
// home. The style file persists (so a completed pack's bookkeeping is stable)
// and is removed when its region is deleted. Loopback cleartext is allowed via
// the withLocalhostCleartext plugin.
//
// This folder name is on the server's allowlist (`SERVED_DOCUMENT_PREFIXES`);
// renaming it here without renaming it there would 403 every download.
const STYLES_DIR = 'offline-styles';

function stylesDirectory(): Directory {
  const dir = new Directory(Paths.document, STYLES_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function styleFile(id: string): File {
  return new File(stylesDirectory(), `${id}.json`);
}

/** Write the serialized style to its file (overwriting any previous version). */
function writeStyleFile(id: string, styleJSON: string): void {
  const f = styleFile(id);
  if (f.exists) f.delete();
  f.create();
  f.write(styleJSON);
}

export interface OfflineRegion {
  id: string;
  /** MapLibre's own id for the pack (a UUID): what a re-download replaces. */
  packId: string;
  label: string;
  /**
   * What the pack holds. `relief` only on packs downloaded before #484
   * retired that base map: still listed and deletable, never drawn.
   */
  basemap: PackBasemap;
  bounds: BoundingBox;
  sizeBytes: number;
  complete: boolean;
  /**
   * Top zoom the pack stored tiles for. Absent on packs downloaded before it
   * was recorded — consumers should assume the shallowest quality option
   * (`OFFLINE_PACK_FALLBACK_MAX_ZOOM`) so overzoom stays safe.
   */
  maxZoom?: number;
  /**
   * Raster image tiles or our vector base map. Packs from before the vector
   * map carry no format and are raster.
   */
  format: PackFormat;
  /** Extensions whose tiles the pack already holds (absent: none). */
  includes?: ExtensionKind[];
  /**
   * The URL templates the pack was built with — its tiles' cache keys
   * (`@core/map/tileUrls`). Absent on packs from before they were recorded;
   * the offline store stamps those on first read.
   */
  urls?: UrlTemplates;
}

// MapLibre LngLatBounds is [west, south, east, north].
const toLngLatBounds = (b: BoundingBox): [number, number, number, number] => [
  b.minLng,
  b.minLat,
  b.maxLng,
  b.maxLat,
];

// Metadata stored inside each OfflinePack (alongside the auto-generated pack UUID).
// We embed our own `id` here because OfflinePackCreateOptions has no `name` field —
// the native layer assigns a UUID that we cannot control.
interface PackMeta {
  // Our app-level region identifier (opaque string, e.g. uuid or slug).
  appId: string;
  label: string;
  basemap: OfflineRegion['basemap'];
  // Top downloaded zoom — lets the live map overscale past the pack instead of
  // requesting tiles that were never stored. Absent on pre-existing packs.
  maxZoom?: number;
  // 'vector' for our Protomaps base map; absent (= raster) on older packs.
  format?: PackFormat;
  /**
   * An extension's companion pack (Settings → Extensions): the extension's
   * tiles for a region downloaded before the extension was installed. Never
   * listed as a region; deleted with the region it belongs to (`companionOf`).
   */
  extension?: ExtensionKind;
  companionOf?: string;
  /** Extensions whose tiles this pack's own style already carried. */
  includes?: ExtensionKind[];
  /**
   * Every URL template the pack's style referenced (`styleUrlTemplates`): the
   * keys its tiles are stored under. Compared with today's templates to flag a
   * pack the live map can no longer read (P1-2). Absent on older packs.
   */
  urls?: UrlTemplates;
  /**
   * When the pack was created (epoch ms). Picks the newer of two packs that
   * share an `appId` — an update in flight, or one killed mid-way
   * (`listRegionPacks`). Absent on older packs (counts as oldest).
   */
  createdAt?: number;
}

/** Extensions that can add a companion pack to an offline region. */
export type ExtensionKind = 'geodetic';

/** An extension's companion pack, as the extension's settings list it. */
export interface CompanionPack {
  id: string;
  companionOf: string;
  sizeBytes: number;
  complete: boolean;
}

function regionFromPack(
  packId: string, // native UUID assigned by MapLibre
  metadata: Record<string, unknown>,
  bounds: [number, number, number, number],
  status?: { percentage: number; completedTileSize: number; completedResourceSize: number },
): OfflineRegion {
  const meta = metadata as Partial<PackMeta>;
  const [w, s, e, n] = bounds;
  const urls = parseUrlTemplates(meta.urls);
  return {
    id: (meta.appId as string | undefined) ?? packId,
    packId,
    label: (meta.label as string | undefined) ?? 'Region',
    basemap: normalizePackBasemap(meta.basemap),
    bounds: { minLng: w, minLat: s, maxLng: e, maxLat: n },
    // Tile bytes are the number users care about; fall back to the total
    // resource bytes when the platform reports 0 tile bytes for a pack that
    // clearly has content (seen on iOS, where tiles were on disk but the
    // tile-size field of the first status read was 0 — #127).
    sizeBytes: status ? status.completedTileSize || status.completedResourceSize : 0,
    complete: (status?.percentage ?? 0) >= 100,
    format: meta.format === 'vector' ? 'vector' : 'raster',
    ...(Array.isArray(meta.includes) && meta.includes.includes('geodetic')
      ? { includes: ['geodetic' as const] }
      : {}),
    ...(urls !== null ? { urls } : {}),
    // Only trust a sane recorded number; legacy packs simply omit it.
    ...(typeof meta.maxZoom === 'number' && Number.isFinite(meta.maxZoom)
      ? { maxZoom: meta.maxZoom }
      : {}),
  };
}

/**
 * The download failed because the device could not reach the tile server —
 * offline, connection lost or refused, timed out, or no tile for 90 s. The
 * message tells the user; it is not reported as an app error (#384, #397,
 * #409, #410 were the same offline phone retrying).
 */
export class OfflineConnectivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineConnectivityError';
  }
}

/** The native error as an Error a user can act on: see {@link describeNativeError}. */
function nativeDownloadError(message: string, zoomRange: string): Error {
  const description = describeNativeError(message, zoomRange);
  return description.startsWith('network error at ')
    ? new OfflineConnectivityError(description)
    : new Error(description);
}

/**
 * Turn MapLibre's native download error into something a user can act on.
 * Native messages are terse and sometimes empty ("" from an OfflineRegionError
 * with no reason), which is how a failing layer used to surface as nothing more
 * than "Relief failed to download".
 */
function describeNativeError(message: string, zoomRange: string): string {
  const raw = message.trim();
  const lower = raw.toLowerCase();
  if (raw === '') return `the tile server rejected the request (${zoomRange})`;
  // Out-of-space writes fail deep in MapLibre's native tile DB (SQLITE_FULL /
  // ENOSPC). Name the real cause instead of leaving it as a generic failure —
  // the preflight blocks most of these, but a disk can fill mid-download too.
  if (isOutOfSpaceMessage(lower)) {
    return `not enough free space to store the tiles (${zoomRange}) — free up space and retry`;
  }
  if (lower.includes('tile limit') || lower.includes('tilecountlimit')) {
    return `too many tiles — shrink the area or lower the quality (${zoomRange})`;
  }
  if (lower.includes('offline region definition') || lower.includes('invalid')) {
    return `invalid zoom range ${zoomRange} for this basemap`;
  }
  if (lower.includes('connect') || lower.includes('network') || lower.includes('timed out')) {
    return `network error at ${zoomRange} — ${raw}`;
  }
  return `${raw} (${zoomRange})`;
}

function styleHasSource(styleJSON: string, source: string): boolean {
  try {
    const sources = (JSON.parse(styleJSON) as { sources?: Record<string, unknown> }).sources;
    return sources !== undefined && source in sources;
  } catch {
    return false;
  }
}

export async function createRegionPack(
  args: {
    id: string;
    label: string;
    /** New packs are only ever a live base map (never the retired relief). */
    basemap: Basemap;
    /** Default raster; `vector` for a Stone & Paper `map` pack. */
    format?: PackFormat;
    styleJSON: string;
    bounds: BoundingBox;
    minZoom: number;
    maxZoom: number;
    /** Set for an extension's companion pack (see {@link PackMeta.extension}). */
    companion?: { extension: ExtensionKind; of: string };
  },
  onProgress: (pct: number, sizeBytes: number) => void,
  /**
   * Native id of a pack this one replaces (see {@link replaceRegionPack}):
   * deleted once the new pack completes, and left alone if it fails.
   */
  replacing?: string,
): Promise<void> {
  // Last line of defence for the zoom range: a pack may only request zooms its
  // basemap's tile source actually serves (satellite: z17) and MapLibre rejects an
  // inverted range outright. Clamping here means no caller can create a pack
  // that is doomed before the first tile is fetched.
  const format = args.format ?? 'raster';
  const { minZoom, maxZoom } = packZoomRange(args.basemap, args.minZoom, args.maxZoom, format);

  // OfflinePackCreateOptions has no `name` field — the native layer assigns a UUID.
  // We embed our app-level id in metadata so we can recover it in listRegionPacks().
  // `maxZoom` is the CLAMPED one — it must describe what the pack really stores,
  // or the live map would overzoom onto tiles the pack never downloaded.
  const meta: PackMeta = {
    appId: args.id,
    label: args.label,
    basemap: args.basemap,
    maxZoom,
    format,
    ...(args.companion
      ? { extension: args.companion.extension, companionOf: args.companion.of }
      : {}),
    ...(!args.companion && styleHasSource(args.styleJSON, 'geodetic')
      ? { includes: ['geodetic'] }
      : {}),
    urls: styleUrlTemplates(args.styleJSON),
    createdAt: Date.now(),
  };

  // Native pack id, captured from the progress/error listener's pack arg so we can
  // delete a partially-created pack if the download errors out.
  let nativePackId: string | undefined;
  // The lease on the shared loopback server, held until the download settles.
  let lease: LocalServerLease | undefined;

  // Quoted in every failure message: a download that fails at z13–z15 vs one
  // that fails before a single tile is requested are different bugs.
  const zoomRange = `z${minZoom}–z${maxZoom}`;

  // A replaced pack shares the id, and with it the style file. Keep what it
  // held, to put back should the update fail: the legacy migration reads a
  // pack's templates from that file, so it must keep describing the old pack.
  let previousStyle: string | null = null;
  if (replacing !== undefined) {
    const f = styleFile(args.id);
    previousStyle = f.exists ? await f.text().catch(() => null) : null;
  }

  try {
    writeStyleFile(args.id, args.styleJSON);

    // Serve the style file over loopback http so MapLibre's offline downloader can
    // fetch it (see the module header). The lease resolves only once the shared
    // server is ACTIVE; the rasterizer may already be holding it.
    lease = await acquireLocalServer();
    const styleUrl = servedFileUrl(lease.value, `${STYLES_DIR}/${args.id}.json`);
    if (styleUrl === null)
      throw new Error(`style path is not servable: ${STYLES_DIR}/${args.id}.json`);

    await new Promise<void>((resolve, reject) => {
      // Stall watchdog: MapLibre's downloader can simply stop emitting progress
      // (no error event) when connectivity drops mid-download. Without a
      // timeout this promise never settles, the caller's `finally` never runs,
      // and the download UI stays disabled until the app is force-killed.
      const STALL_MS = 90_000;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        fn();
      };
      const armWatchdog = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(
          () =>
            settle(() =>
              reject(
                new OfflineConnectivityError(
                  `no tiles arrived for 90 s at ${zoomRange} — check your connection`,
                ),
              ),
            ),
          STALL_MS,
        );
      };
      armWatchdog();
      OfflineManager.createPack(
        {
          mapStyle: styleUrl,
          bounds: toLngLatBounds(args.bounds),
          minZoom,
          maxZoom,
          metadata: meta as unknown as Record<string, unknown>,
        },
        (pack, status) => {
          nativePackId = pack.id;
          if (settled) return;
          armWatchdog();
          onProgress(status.percentage, status.completedTileSize);
          if (status.percentage >= 100) settle(resolve);
        },
        (pack, err) => {
          nativePackId = pack.id;
          settle(() => reject(nativeDownloadError(err.message, zoomRange)));
        },
      )
        .then((pack) => {
          nativePackId = pack.id;
        })
        .catch((err: unknown) =>
          settle(() =>
            reject(
              nativeDownloadError(err instanceof Error ? err.message : String(err), zoomRange),
            ),
          ),
        );
    });
  } catch (err) {
    // Best-effort: delete the partially-created native pack (so it doesn't show up
    // in Settings as a real region) and its orphaned style file. Don't mask `err`.
    if (nativePackId !== undefined) {
      await OfflineManager.deletePack(nativePackId).catch(() => undefined);
    }
    // A replaced pack gets its own style back (see `previousStyle`).
    try {
      if (previousStyle !== null) writeStyleFile(args.id, previousStyle);
      else {
        const f = styleFile(args.id);
        if (f.exists) f.delete();
      }
    } catch {
      // Best-effort; never mask `err`.
    }
    throw err;
  } finally {
    // The style is fetched once at the start of the download; the tiles stream from
    // their real https endpoints, so the lease can go on completion (the server
    // itself stops only if nobody else — the rasterizer — still holds one).
    // `lease` is undefined if acquiring it failed (nothing to release then).
    if (lease) await lease.release();
  }
  // Only now that the new pack is complete does the one it replaces go: a
  // failed re-download leaves the user what they had.
  // (Best-effort: should it fail, `deleteRegionPack` still removes both later.)
  if (replacing === undefined) return;
  await OfflineManager.deletePack(replacing).catch(() => undefined);
  // The new pack carries the geodetic marks itself: the region's companion
  // pack (added when the extension was installed) is now redundant.
  if (meta.includes?.includes('geodetic')) {
    await deleteCompanionsOf(args.id, 'geodetic').catch(() => undefined);
  }
}

/** Delete `regionId`'s companion pack(s) for one extension, and their style files. */
async function deleteCompanionsOf(regionId: string, extension: ExtensionKind): Promise<void> {
  for (const p of await OfflineManager.getPacks()) {
    const meta = p.metadata as Partial<PackMeta>;
    if (meta.extension !== extension || meta.companionOf !== regionId) continue;
    await OfflineManager.deletePack(p.id);
    const f = styleFile(meta.appId ?? p.id);
    if (f.exists) f.delete();
  }
}

/**
 * Download a region again under the same app-level id, with today's style —
 * the "needs update" action for a pack built with URL templates the app no
 * longer uses (P1-2). The old pack (native id `oldPackId`) stays until the
 * new one completes, so a failure loses nothing.
 */
export async function replaceRegionPack(
  oldPackId: string,
  args: Parameters<typeof createRegionPack>[0],
  onProgress: (pct: number, sizeBytes: number) => void,
): Promise<void> {
  // An earlier update killed mid-way left an incomplete pack under this id:
  // drop it first, so a region never ends up with three packs.
  for (const p of await OfflineManager.getPacks()) {
    const meta = p.metadata as Partial<PackMeta>;
    if (meta.appId !== args.id || meta.extension !== undefined || p.id === oldPackId) continue;
    const status = await packStatusWithSizeRetry(p);
    if ((status?.percentage ?? 0) < 100) {
      await OfflineManager.deletePack(p.id).catch(() => undefined);
    }
  }
  return createRegionPack(args, onProgress, oldPackId);
}

/**
 * The URL templates a pack's saved style references (`offline-styles/<id>.json`,
 * written when it was downloaded), or null without one: the faithful record of
 * what a pack from before `PackMeta.urls` was built with.
 */
export async function readPackStyleTemplates(id: string): Promise<UrlTemplates | null> {
  try {
    const f = styleFile(id);
    if (!f.exists) return null;
    const urls = styleUrlTemplates(await f.text());
    return Object.keys(urls).length > 0 ? urls : null;
  } catch {
    return null;
  }
}

/** The subset of MapLibre's OfflinePackStatus that region listing consumes. */
interface PackStatus {
  percentage: number;
  completedTileSize: number;
  completedResourceSize: number;
}

/**
 * Read a pack's status, retrying once when the first answer reports zero
 * bytes. On iOS the first `status()` after launch races the native layer's
 * lazy progress computation (`MLNOfflinePack` starts in an Unknown state with
 * a zeroed progress struct until `requestProgress` completes), which is how a
 * fully-downloaded pack showed as "0 KB" in Settings (#127). The first call
 * warms the native progress; the immediate re-query then reads real numbers.
 * On Android the first answer is already non-zero, so the retry never fires.
 */
async function packStatusWithSizeRetry(pack: {
  status(): Promise<PackStatus>;
}): Promise<PackStatus | undefined> {
  const first = await pack.status().catch(() => undefined);
  if (first && (first.completedTileSize > 0 || first.completedResourceSize > 0)) return first;
  const second = await pack.status().catch(() => undefined);
  return second ?? first;
}

/**
 * One region per app-level id. Two packs share one while an update runs (the
 * old pack stays until the new one completes — `replaceRegionPack`), and for
 * good if the app is killed mid-update: the region is then the newest
 * COMPLETE pack, else the newest one (see `PackMeta.createdAt`).
 */
export async function listRegionPacks(): Promise<OfflineRegion[]> {
  const packs = await OfflineManager.getPacks();
  const byId = new Map<string, { region: OfflineRegion; createdAt: number }>();
  for (const p of packs) {
    const meta = p.metadata as Partial<PackMeta>;
    // An extension's companion pack is part of its region, not a region.
    if (meta.extension !== undefined) continue;
    const status = await packStatusWithSizeRetry(p);
    const region = regionFromPack(
      p.id,
      p.metadata,
      p.bounds as [number, number, number, number],
      status,
    );
    const createdAt = typeof meta.createdAt === 'number' ? meta.createdAt : 0;
    const prev = byId.get(region.id);
    const better =
      prev === undefined ||
      (region.complete !== prev.region.complete ? region.complete : createdAt > prev.createdAt);
    if (better) byId.set(region.id, { region, createdAt });
  }
  return [...byId.values()].map((e) => e.region);
}

/** An extension's companion packs (one per region downloaded before it was installed). */
export async function listCompanionPacks(extension: ExtensionKind): Promise<CompanionPack[]> {
  const packs = await OfflineManager.getPacks();
  const out: CompanionPack[] = [];
  for (const p of packs) {
    const meta = p.metadata as Partial<PackMeta>;
    if (meta.extension !== extension || typeof meta.companionOf !== 'string') continue;
    const status = await packStatusWithSizeRetry(p);
    out.push({
      id: meta.appId ?? p.id,
      companionOf: meta.companionOf,
      sizeBytes: status ? status.completedTileSize || status.completedResourceSize : 0,
      complete: (status?.percentage ?? 0) >= 100,
    });
  }
  return out;
}

/** Remove every companion pack of an extension (its "Remove extension"). */
export async function deleteCompanionPacks(extension: ExtensionKind): Promise<void> {
  for (const c of await listCompanionPacks(extension)) await deleteRegionPack(c.id);
}

/**
 * Deletes the offline pack whose app-level id matches the given string, and
 * any extension companion packs that belong to it.
 * Because MapLibre uses auto-generated UUIDs as the native pack identifier,
 * we scan the pack list to find the matching pack by its metadata.appId.
 */
export async function deleteRegionPack(id: string): Promise<void> {
  const packs = await OfflineManager.getPacks();
  for (const p of packs) {
    const meta = p.metadata as Partial<PackMeta>;
    // Fall back to native pack UUID for packs created before metadata.appId was added.
    const mine = meta.appId === id || p.id === id;
    const companion = meta.companionOf === id;
    if (!mine && !companion) continue;
    await OfflineManager.deletePack(p.id);
    // Remove the serialized style file we wrote for this pack (best-effort).
    const f = styleFile(meta.appId ?? id);
    if (f.exists) f.delete();
  }
  const f = styleFile(id);
  if (f.exists) f.delete();
}

/**
 * Force offline-only tile serving (true) or normal fetching (false). One switch
 * governs every tile path: MapLibre's native fetches (NetworkManager), the raw
 * 3D DEM/basemap downloads (storage.downloadBytes) and the weather drape's
 * frame downloads (weatherFrames) — cached tiles still serve.
 *
 * Turning it ON also drops the weather frame cache. Those PNGs are pure
 * network convenience: the drape does not draw at all in offline-only mode,
 * and a frame URL never recurs once TIME has moved on, so the cache is worth
 * nothing here while the disk it holds is worth something.
 */
export function setOfflineOnly(on: boolean): void {
  NetworkManager.setConnected(!on);
  setNetworkAllowed(!on);
  if (on) clearWeatherFrames();
}

export function setTileLimit(n: number): void {
  OfflineManager.setTileCountLimit(n);
}
