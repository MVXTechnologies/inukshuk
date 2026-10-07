/**
 * The climbing-crags extension's actions (Explore, the topo, Settings →
 * Extensions → Climbing crags, Library › Climbing):
 *
 * - **Download a crag** (owner decision Q1-A): its topo (routes + diagrams,
 *   a few KB) and a 2 km crag & approach map, z12–16 of the base map with the
 *   crag layer (`createRegionPack`, a companion pack of the crag). The first
 *   download installs the extension and turns it on (Q3-A) so the crag is on
 *   the main map at once; "Show every crag" stays as it was (off by default).
 *   Closed or banned crags are never downloadable.
 * - **Update** replaces the topo, keeps the map pack and the attachments.
 * - **Remove** deletes the topo, its map pack and its attachments.
 * - **Attach my topo** (Q7-A): the user's own photo or PDF, copied into the
 *   app's documents, local only, never synced.
 */
import { downloadable } from '@core/climbing/crag';
import {
  cragMapBounds,
  cragPoints,
  CRAG_MAP_ZOOMS,
  savedFromDetail,
  type CragAttachment,
} from '@core/climbing/saved';
import { estimateRegionDownload } from '@core/geo/tiles';
import {
  buildCragTileLayers,
  CRAG_SOURCE,
  CRAG_SOURCE_MAXZOOM,
  CRAG_SOURCE_MINZOOM,
} from '@core/map/climbingStyle';
import { STONE_FONTS_ATKINSON, STONE_FONTS_NOTO } from '@core/map/stoneStyle';
import {
  cragTilesUrl,
  deleteAttachment,
  deleteSavedTopo,
  fetchTopo,
  importAttachment,
  loadClimbingCoverage,
  writeSavedTopo,
} from '@data/climbing';
import { assessFreeSpaceForWrite } from '@data/diskSpace';
import {
  createRegionPack,
  deleteCompanionPacks,
  deleteRegionPack,
  listCompanionPacks,
} from '@data/offline';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { useClimbingStore } from '@state/climbingStore';
import { useSettingsStore } from '@state/settingsStore';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { vectorGlyphsUrl } from '@data/basemapTiles';
import { MAP_PACK_FORMAT } from '../map/mapStyle';
import { packStyle } from '../map/hooks/useOfflineDownload';

/** What the confirm sheet shows: the map pack's estimated size. */
export function estimateCragMap(points: [number, number][]): number {
  const bounds = cragMapBounds(points);
  return estimateRegionDownload(
    bounds,
    CRAG_MAP_ZOOMS.min,
    CRAG_MAP_ZOOMS.max,
    ['map'],
    MAP_PACK_FORMAT,
  ).bytes;
}

const packIdFor = (uid: string) => `crag-${uid.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** The crag-map pack's style: the base map (contours included) plus the crag layer. */
function cragPackStyle(): string {
  const s = useSettingsStore.getState();
  const base = packStyle(s.tileUrl, 'map', MAP_PACK_FORMAT) as unknown as {
    sources: Record<string, unknown>;
    layers: { id: string }[];
    glyphs?: string;
  };
  const tiles = cragTilesUrl();
  if (tiles !== null && !(CRAG_SOURCE in base.sources)) {
    // A pack stores the tiles of the sources its layers draw: the crag layer
    // rides along, so the crag's badge and route starts work offline too.
    base.sources[CRAG_SOURCE] = {
      type: 'vector',
      tiles: [tiles],
      minzoom: CRAG_SOURCE_MINZOOM,
      maxzoom: CRAG_SOURCE_MAXZOOM,
    };
    const glyphs = base.glyphs ?? vectorGlyphsUrl() ?? undefined;
    if (glyphs !== undefined) {
      base.glyphs = glyphs;
      base.layers.push(
        ...buildCragTileLayers({
          theme: 'light',
          font: glyphs === vectorGlyphsUrl() ? STONE_FONTS_ATKINSON.bold : STONE_FONTS_NOTO.bold,
          prefix: 'pack-crags',
        }),
      );
    }
  }
  return JSON.stringify(base);
}

export function installClimbing(): void {
  const { set, climbingInstalledAt } = useSettingsStore.getState();
  if (climbingInstalledAt === 0) set('climbingInstalledAt', Date.now());
  set('showClimbing', true);
  void refreshClimbingCoverage();
}

export async function refreshClimbingCoverage(): Promise<void> {
  const coverage = await loadClimbingCoverage();
  if (coverage) useClimbingStore.getState().patch({ coverage });
}

export class CragDownloadError extends Error {}

/**
 * Download (or update) a crag. `withMap` false = the topo only (an update, or
 * a user who already has the area offline). Resolves when everything is saved.
 */
export async function downloadCrag(uid: string, options: { withMap: boolean }): Promise<void> {
  const store = useClimbingStore.getState();
  if (store.downloads[uid]) return;
  if (useSettingsStore.getState().offlineOnly) {
    throw new CragDownloadError("Turn off 'Locally downloaded only' to download a crag");
  }
  const previous = store.saved.find((s) => s.uid === uid);
  store.setDownload(uid, { phase: 'topo', pct: 0, bytes: 0, expectedBytes: 0 });
  try {
    const topo = await fetchTopo(uid);
    if (topo === null || topo.from !== 'network') {
      throw new CragDownloadError("Couldn't reach the topo server — check your connection");
    }
    const d = topo.detail;
    if (!downloadable(d.access.status)) {
      throw new CragDownloadError('Access to this crag is closed: it can’t be downloaded');
    }
    let packId = previous?.packId ?? null;
    let packBytes = previous?.packBytes ?? 0;
    if (options.withMap && packId === null) {
      const points = cragPoints(d);
      const expectedBytes = estimateCragMap(points);
      const budget = assessFreeSpaceForWrite(expectedBytes);
      if (budget?.verdict === 'block') {
        throw new CragDownloadError(budget.message ?? 'Not enough free space for this crag’s map');
      }
      packId = packIdFor(uid);
      useClimbingStore
        .getState()
        .setDownload(uid, { phase: 'map', pct: 0, bytes: 0, expectedBytes });
      await createRegionPack(
        {
          id: packId,
          label: `${d.name} · crag map`,
          basemap: 'map',
          format: MAP_PACK_FORMAT,
          styleJSON: cragPackStyle(),
          bounds: cragMapBounds(points),
          minZoom: CRAG_MAP_ZOOMS.min,
          maxZoom: CRAG_MAP_ZOOMS.max,
          companion: { extension: 'climbing', of: uid },
        },
        (pct, bytes) => {
          packBytes = bytes;
          useClimbingStore.getState().setDownload(uid, { phase: 'map', pct, bytes, expectedBytes });
        },
      );
    }
    const topoBytes = writeSavedTopo(uid, topo.raw);
    useClimbingStore
      .getState()
      .put(savedFromDetail(d, { savedAt: Date.now(), topoBytes, packId, packBytes }, previous));
    installClimbing();
  } catch (err) {
    if (!(err instanceof CragDownloadError)) reportError(err, 'climbing-download');
    throw err;
  } finally {
    useClimbingStore.getState().setDownload(uid, null);
  }
}

export async function removeCrag(uid: string): Promise<void> {
  const crag = useClimbingStore.getState().saved.find((s) => s.uid === uid);
  if (!crag) return;
  useClimbingStore.getState().drop([uid]);
  deleteSavedTopo(uid);
  for (const a of crag.attachments) deleteAttachment(a.path);
  if (crag.packId !== null) {
    await deleteRegionPack(crag.packId).catch((err: unknown) =>
      reportError(err, 'climbing-remove'),
    );
  }
}

/** Settings → Remove extension: every saved crag, its map and its attachments. */
export async function removeClimbing(): Promise<void> {
  const { saved } = useClimbingStore.getState();
  for (const c of saved) await removeCrag(c.uid);
  await deleteCompanionPacks('climbing').catch((err: unknown) =>
    reportError(err, 'climbing-remove'),
  );
  const { set } = useSettingsStore.getState();
  set('climbingInstalledAt', 0);
  set('climbingShowAll', false);
}

/** The map packs' real sizes (the progress callback can under-report on iOS). */
export async function refreshCragPackSizes(): Promise<void> {
  try {
    const packs = await listCompanionPacks('climbing');
    const store = useClimbingStore.getState();
    for (const c of store.saved) {
      const p = packs.find((x) => x.companionOf === c.uid);
      if (p && p.sizeBytes > 0 && p.sizeBytes !== c.packBytes) {
        store.put({ ...c, packBytes: p.sizeBytes });
      }
    }
  } catch (err) {
    reportError(err, 'climbing-packs');
  }
}

/**
 * "Attach my topo": a photo of a guidebook page or a PDF the user owns.
 * Local only. Returns the attachment, or null when the user backed out.
 */
export async function attachTopo(
  uid: string,
  from: 'photo' | 'file',
): Promise<CragAttachment | null> {
  const crag = useClimbingStore.getState().saved.find((s) => s.uid === uid);
  if (!crag) return null;
  let uri: string | undefined;
  let name: string;
  let kind: CragAttachment['kind'];
  let ext: string;
  if (from === 'photo') {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    const asset = res.canceled ? undefined : res.assets[0];
    uri = asset?.uri;
    name = asset?.fileName ?? 'Topo photo';
    kind = 'image';
    ext = uri?.split('?')[0]?.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg';
  } else {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
    });
    const asset = res.canceled ? undefined : res.assets[0];
    uri = asset?.uri;
    name = asset?.name ?? 'Topo';
    const isPdf = (asset?.mimeType ?? name).toLowerCase().includes('pdf');
    kind = isPdf ? 'pdf' : 'image';
    ext = isPdf ? 'pdf' : (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg');
  }
  if (!uri) return null;
  const id = storage.newId();
  const { path, bytes } = await importAttachment(uri, id, ext);
  const attachment: CragAttachment = { id, kind, name, path, bytes, addedAt: Date.now() };
  const latest = useClimbingStore.getState().saved.find((s) => s.uid === uid);
  if (latest)
    useClimbingStore
      .getState()
      .put({ ...latest, attachments: [...latest.attachments, attachment] });
  return attachment;
}

export function removeAttachment(uid: string, id: string): void {
  const crag = useClimbingStore.getState().saved.find((s) => s.uid === uid);
  const a = crag?.attachments.find((x) => x.id === id);
  if (!crag || !a) return;
  deleteAttachment(a.path);
  useClimbingStore
    .getState()
    .put({ ...crag, attachments: crag.attachments.filter((x) => x.id !== id) });
}
