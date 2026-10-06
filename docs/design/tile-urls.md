# Tile URLs are the offline cache key

Architecture review P1-2. Read this before you change any tile, glyph or
source URL, the `?v=` on one, or the tile host.

## Why a URL change breaks the app

MapLibre's offline packs store each tile, glyph range and sprite under the
**exact URL** the pack's style named: host, path and query. The live map
finds a downloaded tile only if it asks for the very same string. Change a
template the app uses and every region downloaded with the old one is
orphaned. In the field, the map goes blank where the user thought it was
downloaded. An OTA does that to every user at once.

## The guards

| Guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Where                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Frozen contract.** A test builds the real styles (offline packs and the live map, every layer on) and pins every URL they reference. Changing one fails CI.                                                                                                                                                                                                                                                                                                                                                                                                    | `src/features/map/tileUrls.contract.test.ts`                                                           |
| **Packs record their templates.** Each new pack stores the templates its style referenced (`PackMeta.urls`, from `styleUrlTemplates`).                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/data/offline.ts`, `src/core/map/tileUrls.ts`                                                      |
| **Migration for older packs.** On first read, a pack with no record is stamped with the templates from its own saved style (`offline-styles/<id>.json`). If it has no saved style, it is stamped with today's base-layer templates, i.e. treated as matching (extension templates are left out: nothing says the pack holds them). Stamps live in the `offline-pack-urls.json` sidecar, because MapLibre cannot edit a pack's metadata after creation.                                                                                                           | `src/state/offlineStore.ts` (`loadRegions`), `src/data/packUrls.ts`, `useOfflinePackHealth`            |
| **Mismatch detection.** A pack's recorded templates are compared with those a pack of the same kind would get today (`staleTemplateKeys`). A source only one side has is not a mismatch.                                                                                                                                                                                                                                                                                                                                                                         | `src/features/map/offlinePackHealth.ts`                                                                |
| **The user is told.** The map shows a snackbar ("N offline maps need updating", with a View action to Settings) when a map joins the stale list; the announced list persists, so it does not repeat on every cold start. A trail download's parts count, and update, as one map. Settings → Offline maps shows the region as "Needs update" with a download button. The re-download reuses the region's id, bounds and quality. The old pack stays until the new one is complete; its templates are stamped first, and a failed update restores its saved style. | `useOfflinePackHealthNotice` (via `useOfflineDownload`), `OfflineMapsSection.tsx`, `replaceRegionPack` |

## Moving the tile host: one line, no re-download

`src/data/basemapTiles.ts` has two hosts:

- `TILE_KEY_HOST` is the host written into every template. It is the cache
  key. **Never change it.**
- `TILE_HOST` is where requests really go. **The host move is this one line.**

All plain `fetch` callers use `TILE_HOST` (routing, search, donors, Strava,
long trails, coverage JSON). MapLibre's requests keep the `TILE_KEY_HOST`
templates. `installTileHostAlias()` runs at startup (`app/_layout.tsx`) and
registers a `TransformRequestManager` URL transform that rewrites
`TILE_KEY_HOST` to `TILE_HOST`. MapLibre applies that transform in its HTTP
layer (an OkHttp interceptor on Android, the `MLNNetworkConfiguration`
delegate on iOS). That is **after** the offline-database lookup, which still
uses the template URL, so every downloaded region keeps working with no
re-download. Code that fetches tiles itself (contour recovery) uses
`tileFetchUrl()` for the same rewrite.

While the two hosts are equal (today), the alias is a no-op and no native
module is touched. The transform API ships in the native binary already
(`@maplibre/maplibre-react-native` 11.4), so the move is OTA-able.

The move, step by step:

1. Serve the Worker on the new domain too, with the same paths.
2. Set `TILE_HOST` to the new domain, and update its expected value in the
   contract test.
3. Verify on a device with an existing region: offline-only mode still
   draws it, and online requests reach the new host.

## Changing a tile schema (`?v=`, or a path)

This time the URL has to change: old tiles hold the old schema. Bumping it
orphans that layer in every region. Since this change, the regions are
flagged "Needs update" instead of silently going blank.

1. Bump the template in `basemapTiles.ts` and its expected value in the
   contract test, and say why in the PR.
2. Expect affected users to see "N offline maps need updating". Say so in
   the release notes.
3. Prefer versioning in the **path** for new layers (`/geodetic2/{z}/{x}/{y}`)
   so caches and Worker routes stay simple.

## Not covered (yet)

- Geodetic **companion** packs record their templates like any pack, but
  only regions are checked and offered a re-download. A stale companion just
  loses its marks offline until its region is downloaded again.
- Marine packs (`src/data/marinePacks.ts`) are files, not MapLibre packs.
  They are not keyed by URL.
