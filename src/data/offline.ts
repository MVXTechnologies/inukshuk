import StaticServer from '@dr.pogodin/react-native-static-server';
import { Directory, File, Paths } from 'expo-file-system';

import { packZoomRange } from '@core/geo/tiles';
import { isOutOfSpaceMessage } from '@core/storage/diskBudget';
import type { BoundingBox } from '@core/models';
import { NetworkManager, OfflineManager } from '@maplibre/maplibre-react-native';

import { setNetworkAllowed } from './storage';

// MapLibre's offline `createPack` expects `mapStyle` to be an **http(s) style URL**
// it can fetch through its native HTTP source — inline style JSON AND `file://`
// are both rejected ("Unable to parse resourceUrl …"). So during a download we
// serialize the active basemap's style to a file and serve it from a transient
// in-app HTTP server bound to loopback (127.0.0.1), then hand MapLibre that URL.
// The tiles themselves stream from the real OSM/Esri https endpoints; only the
// tiny style document needs a local http home. The style file persists (so a
// completed pack's bookkeeping is stable) and is removed when its region is
// deleted. Loopback cleartext is allowed via the withLocalhostCleartext plugin.
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

// The static server wants a plain filesystem path; expo-file-system gives file:// URIs.
function fsPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

// The static-server lib permits only ONE active server instance per app. If a
// previous download leaked its server (e.g. an interrupted run), a fresh start()
// throws "another server instance is active". Track the live server here and stop
// any prior one before starting a new one, so downloads never block each other.
let activeStyleServer: StaticServer | null = null;

async function startStyleServer(): Promise<{ server: StaticServer; origin: string }> {
  if (activeStyleServer) {
    await activeStyleServer.stop().catch(() => undefined);
    activeStyleServer = null;
  }
  const server = new StaticServer({
    fileDir: fsPath(stylesDirectory().uri),
    port: 0,
    hostname: '127.0.0.1',
  });
  const origin = await server.start();
  activeStyleServer = server;
  return { server, origin };
}

async function stopStyleServer(server: StaticServer): Promise<void> {
  await server.stop().catch(() => undefined);
  if (activeStyleServer === server) activeStyleServer = null;
}

export interface OfflineRegion {
  id: string;
  label: string;
  basemap: 'map' | 'satellite' | 'relief';
  bounds: BoundingBox;
  sizeBytes: number;
  complete: boolean;
  /**
   * Top zoom the pack stored tiles for. Absent on packs downloaded before it
   * was recorded — consumers should assume the shallowest quality option
   * (`OFFLINE_PACK_FALLBACK_MAX_ZOOM`) so overzoom stays safe.
   */
  maxZoom?: number;
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
}

function regionFromPack(
  packId: string, // native UUID assigned by MapLibre
  metadata: Record<string, unknown>,
  bounds: [number, number, number, number],
  status?: { percentage: number; completedTileSize: number },
): OfflineRegion {
  const meta = metadata as Partial<PackMeta>;
  const [w, s, e, n] = bounds;
  return {
    id: (meta.appId as string | undefined) ?? packId,
    label: (meta.label as string | undefined) ?? 'Region',
    basemap: (meta.basemap as OfflineRegion['basemap'] | undefined) ?? 'map',
    bounds: { minLng: w, minLat: s, maxLng: e, maxLat: n },
    sizeBytes: status?.completedTileSize ?? 0,
    complete: (status?.percentage ?? 0) >= 100,
    // Only trust a sane recorded number; legacy packs simply omit it.
    ...(typeof meta.maxZoom === 'number' && Number.isFinite(meta.maxZoom)
      ? { maxZoom: meta.maxZoom }
      : {}),
  };
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

export async function createRegionPack(
  args: {
    id: string;
    label: string;
    basemap: OfflineRegion['basemap'];
    styleJSON: string;
    bounds: BoundingBox;
    minZoom: number;
    maxZoom: number;
  },
  onProgress: (pct: number, sizeBytes: number) => void,
): Promise<void> {
  // Last line of defence for the zoom range: a pack may only request zooms its
  // basemap's tile source actually serves (relief: z15) and MapLibre rejects an
  // inverted range outright. Clamping here means no caller can create a pack
  // that is doomed before the first tile is fetched.
  const { minZoom, maxZoom } = packZoomRange(args.basemap, args.minZoom, args.maxZoom);

  // OfflinePackCreateOptions has no `name` field — the native layer assigns a UUID.
  // We embed our app-level id in metadata so we can recover it in listRegionPacks().
  // `maxZoom` is the CLAMPED one — it must describe what the pack really stores,
  // or the live map would overzoom onto tiles the pack never downloaded.
  const meta: PackMeta = {
    appId: args.id,
    label: args.label,
    basemap: args.basemap,
    maxZoom,
  };

  // Native pack id, captured from the progress/error listener's pack arg so we can
  // delete a partially-created pack if the download errors out.
  let nativePackId: string | undefined;
  // The loopback server, assigned once started so the finally can always stop it.
  let server: StaticServer | undefined;

  // Quoted in every failure message: a download that fails at z13–z15 vs one
  // that fails before a single tile is requested are different bugs.
  const zoomRange = `z${minZoom}–z${maxZoom}`;

  try {
    writeStyleFile(args.id, args.styleJSON);

    // Serve the style file over loopback http so MapLibre's offline downloader can
    // fetch it (see the module header). Port 0 auto-picks a free port; start()
    // resolves to the origin only once ACTIVE, and stops any leaked prior server.
    const started = await startStyleServer();
    server = started.server;
    const styleUrl = `${started.origin}/${args.id}.json`;

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
                new Error(`no tiles arrived for 90 s at ${zoomRange} — check your connection`),
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
          settle(() => reject(new Error(describeNativeError(err.message, zoomRange))));
        },
      )
        .then((pack) => {
          nativePackId = pack.id;
        })
        .catch((err: unknown) =>
          settle(() =>
            reject(
              new Error(
                describeNativeError(err instanceof Error ? err.message : String(err), zoomRange),
              ),
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
    const f = styleFile(args.id);
    if (f.exists) f.delete();
    throw err;
  } finally {
    // The style is fetched once at the start of the download; the tiles stream from
    // their real https endpoints, so it is safe to tear the server down on completion.
    // `server` is undefined if start() itself failed (nothing to stop in that case).
    if (server) await stopStyleServer(server);
  }
}

export async function listRegionPacks(): Promise<OfflineRegion[]> {
  const packs = await OfflineManager.getPacks();
  const out: OfflineRegion[] = [];
  for (const p of packs) {
    const status = await p.status().catch(() => undefined);
    out.push(
      regionFromPack(p.id, p.metadata, p.bounds as [number, number, number, number], status),
    );
  }
  return out;
}

/**
 * Deletes the offline pack whose app-level id matches the given string.
 * Because MapLibre uses auto-generated UUIDs as the native pack identifier,
 * we scan the pack list to find the matching pack by its metadata.appId.
 */
export async function deleteRegionPack(id: string): Promise<void> {
  const packs = await OfflineManager.getPacks();
  const target = packs.find((p) => {
    const meta = p.metadata as Partial<PackMeta>;
    // Fall back to native pack UUID for packs created before metadata.appId was added.
    return meta.appId === id || p.id === id;
  });
  if (target) {
    await OfflineManager.deletePack(target.id);
  }
  // Remove the serialized style file we wrote for this region (best-effort).
  const f = styleFile(id);
  if (f.exists) f.delete();
}

/**
 * Force offline-only tile serving (true) or normal fetching (false). One switch
 * governs both tile paths: MapLibre's native fetches (NetworkManager) and the raw
 * 3D DEM/basemap downloads (storage.downloadBytes) — cached tiles still serve.
 */
export function setOfflineOnly(on: boolean): void {
  NetworkManager.setConnected(!on);
  setNetworkAllowed(!on);
}

export function setTileLimit(n: number): void {
  OfflineManager.setTileCountLimit(n);
}
