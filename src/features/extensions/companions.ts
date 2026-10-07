/**
 * Companion packs (`@data/offline`): for an extension whose descriptor has
 * `offline.companion`, every offline region downloaded before the install
 * gets a small pack holding only the extension's tiles over its bounds (new
 * regions carry them in their own pack, see `packStyle`). Sequential and
 * best-effort; progress and failures land in `extensionSyncStore`.
 *
 * Network-light: the tiles themselves stream from the tile Worker like the
 * base map; only the companion packs download ahead.
 */
import { EXTENSIONS, type ExtensionKey } from '@core/extensions/registry';
import { vectorGlyphsUrl } from '@data/basemapTiles';
import {
  createRegionPack,
  deleteCompanionPacks,
  listCompanionPacks,
  listRegionPacks,
} from '@data/offline';
import { reportError } from '@lib/errorReporting';
import { useExtensionSyncStore, type CompanionSyncState } from '@state/extensionSyncStore';

import { buildExtensionPackStyle } from '../map/mapStyle';
import { extensionTilesUrl } from './availability';
import { extensionPrefs } from './prefs';

/** The error-report tag: `geodetic-companions`, … */
const tag = (key: ExtensionKey): string => `${key}-companions`;

const patch = (key: ExtensionKey, p: Partial<CompanionSyncState>): void =>
  useExtensionSyncStore.getState().patch(key, p);

export async function refreshCompanions(key: ExtensionKey): Promise<void> {
  try {
    patch(key, { companions: await listCompanionPacks(key) });
  } catch (err) {
    reportError(err, tag(key));
  }
}

/** Give every region that lacks the extension's tiles its companion pack. */
export async function syncCompanions(key: ExtensionKey): Promise<void> {
  const companion = EXTENSIONS[key].offline.companion;
  const tiles = extensionTilesUrl(key);
  const busy = (useExtensionSyncStore.getState().byKey[key]?.syncing ?? null) !== null;
  if (companion === undefined || tiles === null || busy) return;
  try {
    const [regions, companions] = await Promise.all([listRegionPacks(), listCompanionPacks(key)]);
    const have = new Set(companions.map((c) => c.companionOf));
    const todo = regions.filter(
      (r) => r.complete && !(r.includes ?? []).includes(key) && !have.has(r.id),
    );
    if (todo.length === 0) return;
    patch(key, { syncing: { done: 0, total: todo.length }, error: null });
    const style = JSON.stringify(buildExtensionPackStyle(key, tiles, vectorGlyphsUrl()));
    const name = EXTENSIONS[key].label.toLowerCase();
    for (const [i, r] of todo.entries()) {
      // A user who removed the extension or turned offline off mid-way stops it.
      const p = extensionPrefs(key);
      if (p.installedAt === 0 || !p.offline) break;
      try {
        await createRegionPack(
          {
            id: `${r.id}~${key}`,
            label: `${r.label} · ${name}`,
            basemap: 'map',
            format: 'vector',
            styleJSON: style,
            bounds: r.bounds,
            minZoom: companion.minZoom,
            maxZoom: companion.maxZoom,
            companion: { extension: key, of: r.id },
          },
          () => undefined,
        );
      } catch (err) {
        patch(key, {
          error: `Couldn't add the ${companion.items} to ${r.label}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      patch(key, { syncing: { done: i + 1, total: todo.length } });
    }
  } catch (err) {
    reportError(err, tag(key));
  } finally {
    patch(key, { syncing: null });
    await refreshCompanions(key);
  }
}

/** Drop every companion pack of the extension (Remove, or its offline switch off). */
export async function dropCompanions(key: ExtensionKey): Promise<void> {
  await deleteCompanionPacks(key).catch((err: unknown) => reportError(err, tag(key)));
  await refreshCompanions(key);
}
