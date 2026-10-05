/**
 * The geodetic-points extension's actions (Settings → Extensions):
 *
 * - Get: install (the map can draw the marks; the overlays menu gets its
 *   switch), then — with "Offline in your regions" on — give every offline
 *   region downloaded before the install a small companion pack holding the
 *   marks (new regions carry them in their own pack, see `packStyle`).
 * - Remove: drop the companion packs and uninstall.
 *
 * Everything here is network-light: the marks themselves stream from the tile
 * Worker like the base map; only the companion packs download ahead.
 */
import { geodeticTilesUrl, vectorGlyphsUrl } from '@data/basemapTiles';
import { refreshGeodeticCoverage } from '@data/geodeticCoverage';
import {
  createRegionPack,
  deleteCompanionPacks,
  listCompanionPacks,
  listRegionPacks,
} from '@data/offline';
import { reportError } from '@lib/errorReporting';
import { useGeodeticStore } from '@state/geodeticStore';
import { useSettingsStore } from '@state/settingsStore';
import { buildGeodeticPackStyle } from '../map/mapStyle';

export async function refreshCompanions(): Promise<void> {
  try {
    useGeodeticStore.getState().patch({ companions: await listCompanionPacks('geodetic') });
  } catch (err) {
    reportError(err, 'geodetic-companions');
  }
}

/** Give every region that lacks the marks its companion pack. Sequential, best-effort. */
export async function syncGeodeticCompanions(): Promise<void> {
  const store = useGeodeticStore.getState();
  const tiles = geodeticTilesUrl();
  if (tiles === null || store.syncing !== null) return;
  try {
    const [regions, companions] = await Promise.all([
      listRegionPacks(),
      listCompanionPacks('geodetic'),
    ]);
    const have = new Set(companions.map((c) => c.companionOf));
    const todo = regions.filter(
      (r) => r.complete && !(r.includes ?? []).includes('geodetic') && !have.has(r.id),
    );
    if (todo.length === 0) return;
    store.patch({ syncing: { done: 0, total: todo.length }, error: null });
    const style = JSON.stringify(buildGeodeticPackStyle(tiles, vectorGlyphsUrl()));
    for (const [i, r] of todo.entries()) {
      // A user who removed the extension or turned offline off mid-way stops it.
      const s = useSettingsStore.getState();
      if (s.geodeticInstalledAt === 0 || !s.geodeticOffline) break;
      try {
        await createRegionPack(
          {
            id: `${r.id}~geodetic`,
            label: `${r.label} · geodetic points`,
            basemap: 'map',
            format: 'vector',
            styleJSON: style,
            bounds: r.bounds,
            minZoom: 5,
            maxZoom: 13,
            companion: { extension: 'geodetic', of: r.id },
          },
          () => undefined,
        );
      } catch (err) {
        useGeodeticStore.getState().patch({
          error: `Couldn't add the marks to ${r.label}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      useGeodeticStore.getState().patch({ syncing: { done: i + 1, total: todo.length } });
    }
  } catch (err) {
    reportError(err, 'geodetic-companions');
  } finally {
    useGeodeticStore.getState().patch({ syncing: null });
    await refreshCompanions();
  }
}

export function installGeodetic(): void {
  const { set } = useSettingsStore.getState();
  set('geodeticInstalledAt', Date.now());
  set('showGeodetic', true);
  void refreshGeodeticCoverage();
  if (useSettingsStore.getState().geodeticOffline) void syncGeodeticCompanions();
}

export async function setGeodeticOffline(on: boolean): Promise<void> {
  useSettingsStore.getState().set('geodeticOffline', on);
  if (on) {
    await syncGeodeticCompanions();
  } else {
    await deleteCompanionPacks('geodetic').catch((err: unknown) =>
      reportError(err, 'geodetic-companions'),
    );
    await refreshCompanions();
  }
}

export async function removeGeodetic(): Promise<void> {
  const { set } = useSettingsStore.getState();
  set('geodeticInstalledAt', 0);
  await deleteCompanionPacks('geodetic').catch((err: unknown) =>
    reportError(err, 'geodetic-companions'),
  );
  await refreshCompanions();
}

export { refreshGeodeticCoverage };
