# Folders-only Library (1.3.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove bundles; make folders the single organize-and-show concept
(including waypoints); mutually exclusive type/folder map-visibility modes; a
read-only waypoint viewer with copy actions; drag-and-drop moves; trail-viewer
2D/3D switch becomes a rail FAB.

**Architecture:** Persisted model changes ride the library migration ladder
(v3→v4: strip `bundles`, add `mapVisibilityMode` + `visibleFolderIds`;
`Waypoint.folderId` is optional so it needs no migration). Visibility filtering
is a pure core helper consumed by MapScreen. The viewer is a bottom card (no
Portal — #108). Drag uses PanResponder + RN Animated (no new animation deps);
the only new dependency is `expo-clipboard` (native → vc48 store build).

**Tech Stack:** Expo SDK 56, RN 0.85, zustand, react-native-paper, MapLibre RN,
expo-clipboard (new), Jest, Maestro.

## Global Constraints

- `src/core/**` stays pure (no react-native/expo imports); new core logic gets co-located `*.test.ts`.
- Strict TS + `noUncheckedIndexedAccess`; lint zero warnings; prettier width 100.
- No Portal/Dialog on tap-response paths for the viewer (bottom card instead) — #108 soft-lock rule.
- Existing persisted data must hydrate: bundles silently dropped, everything else preserved.
- 1.3.0 / versionCode 48; store build (expo-clipboard is native).

---

### Task 1: Relocate `toggleId`; delete bundles from core; migration v3→v4

**Files:**

- Create: `src/core/library/toggleId.ts` + `src/core/library/toggleId.test.ts`
- Delete: `src/core/models/bundle.ts`, `src/core/library/bundles.ts`, `src/core/library/bundles.test.ts`
- Modify: `src/core/models/index.ts` (drop bundle export), `src/core/library/migrations.ts`, `src/core/library/migrations.test.ts`

**Interfaces:**

- Produces: `toggleId(ids: readonly string[], id: string): string[]` (unchanged semantics, new home).
- Produces: `LibraryIndex` without `bundles`, with `mapVisibilityMode: 'type' | 'folders'` and `visibleFolderIds: string[]`; `LIBRARY_SCHEMA_VERSION = 4`; upgrader `3: (doc) => ({ ...doc, bundles: undefined, mapVisibilityMode: 'type', visibleFolderIds: [], schemaVersion: 4 })` (strip via destructure, not `undefined` field). `migrateLibraryIndex` sanitizes: mode defaults `'type'` unless exactly `'folders'`; `visibleFolderIds` filtered to strings.

- [ ] Move `toggleId` with its tests; point `libraryStore` import at the new module.
- [ ] Migration test first: a v3 doc with bundles hydrates to v4 without `bundles`, with defaults; a legacy unversioned doc still ladders fully. Run: fails.
- [ ] Implement interface + ladder step + sanitize. Run: passes.
- [ ] Delete bundle core files + model export; fix migrations fixtures. `npx jest src/core/library` green. Commit.

### Task 2: libraryStore — drop bundle state, add visibility state, waypoint folders

**Files:**

- Modify: `src/state/libraryStore.ts`, `src/state/libraryStore.trackOverlays.test.ts`, `src/state/libraryStore.hydration.test.ts`, `src/state/libraryStore.categories.test.ts`
- Modify: `src/core/models/waypoint.ts` (`folderId?: string`)

**Interfaces:**

- Removes: `bundles`, `addBundle`, `renameBundle`, `removeBundle`, `toggleBundleMap`, `toggleBundleTrack`, `activateBundle`, `pruneBundles` calls in `removeMap`/`removeTrack`.
- Produces: `mapVisibilityMode: 'type' | 'folders'`; `visibleFolderIds: string[]`; `setMapVisibilityMode(mode: 'type' | 'folders'): void`; `toggleVisibleFolder(id: string): void` (uses `toggleId`; `'ungrouped'` is a valid pseudo-id); `setItemFolder(kind: 'map' | 'track' | 'waypoint', itemId, folderId | null)`; `removeFolder` also clears waypoint folderIds; persist() writes the new fields.

- [ ] Store tests first: hydration keeps mode/ids; toggleVisibleFolder round-trips; setItemFolder('waypoint') sets and removeFolder clears. Run: fail. Implement. Run: green.
- [ ] Fix the three existing store test files (drop bundle fixtures/asserts). Full `npx jest src/state` green. Commit.

### Task 3: SettingsScreen export + LibraryScreen bundle removal

**Files:**

- Modify: `src/features/settings/SettingsScreen.tsx` (drop `bundles` from the export snapshot; `exportAllData` typing follows `LibraryIndex`), `src/features/settings/exportAllData.ts` if it names bundles.
- Modify: `src/features/library/LibraryScreen.tsx` — remove: `bundleCounts` import, bundle store hooks, `editingBundle`/`newBundleVisible` state, `createBundle`, `onActivateBundle`, `'bundle'` from `DeleteTarget` + copy map, the Bundles `List.Section` (≈861-945), "Add to bundle" blocks in both item menus, the bundle `NameDialog`.

- [ ] Remove; `npm run check` green (typecheck catches stragglers). Commit.

### Task 4: Folders grow waypoints (core + Library UI)

**Files:**

- Modify: `src/core/library/folders.ts` + `folders.test.ts`
- Modify: `src/features/library/LibraryScreen.tsx`

**Interfaces:**

- Produces: `FolderGroup { folder, maps, tracks, waypoints }`; `groupByFolder(folders, maps, tracks, waypoints): FolderGrouping` (grouping gains `ungroupedWaypoints`); `folderItemCount` counts all three.

- [ ] folders tests first (grouping + counts with waypoints; unknown folderId → ungrouped). Implement. Green.
- [ ] LibraryScreen: pass `waypoints` into `groupByFolder`; render each group's waypoints with `renderWaypointCard`; Ungrouped section includes `ungroupedWaypoints`; the flat Waypoints section remains only when `!hasFolders`; `waypointMenu` gains the same move-to-folder items as trails (via `setItemFolder('waypoint', …)`). `npm run check` green. Commit.

### Task 5: Visibility filtering (core) + MapScreen/LayersMenu modes

**Files:**

- Create: `src/core/library/visibility.ts` + `visibility.test.ts`
- Create: `src/features/map/components/FolderPickerDialog.tsx`
- Modify: `src/features/map/useTrackOverlays.ts` (accept `activeIds: readonly string[]` as a param instead of reading the store), `src/features/map/MapScreen.tsx`, `src/features/map/components/LayersMenu.tsx`

**Interfaces:**

- Produces (core): `UNGROUPED_FOLDER_ID = 'ungrouped'`;
  `visibleMaps(mode, visibleFolderIds, maps): MapDocument[]` (type mode → all);
  `visibleTrackIds(mode, visibleFolderIds, tracks, activeTrackIds): string[]`
  (type mode → activeTrackIds; folder mode → all trails of checked folders);
  `visibleWaypoints(mode, visibleFolderIds, waypoints): Waypoint[]`.
- Produces (UI): `FolderPickerDialog { visible, folders, visibleFolderIds, onToggle(id), onDismiss }` — checkbox list incl. Ungrouped, bound to the store.
- LayersMenu behavior: PDF/Trails checkbox tap → `setMapVisibilityMode('type')` + existing toggle; new "Folders…" item → `setMapVisibilityMode('folders')` + opens picker; checkboxes render un-checked in folder mode, "Folders…" shows a check + count in folder mode.

- [ ] visibility tests first (each selector, both modes, ungrouped pseudo-id). Implement. Green.
- [ ] Wire MapScreen: `usePdfOverlays(visibleMaps(...))`, `useTrackOverlays(tracks, visibleTrackIds(...))`, `visiblePins` filtered by `visibleWaypoints` (live pins always shown while recording). LayersMenu + picker. `npm run check` green. Commit.

### Task 6: Waypoint viewer card + pin highlight (+ expo-clipboard)

**Files:**

- Create: `src/features/map/components/WaypointViewerCard.tsx`
- Create: `src/core/geo/formatCoords.ts` + `formatCoords.test.ts`
- Modify: `src/features/map/MapScreen.tsx`, `src/features/map/components/WaypointMarkerPin.tsx`
- Modify: `package.json` via `npx expo install expo-clipboard`

**Interfaces:**

- Produces (core): `formatLatLng(lat: number, lng: number): string` → `46.81394, -71.20820` (5 decimals, comma-space).
- Produces (UI): `WaypointViewerCard { waypoint: { label, latitude, longitude, note?, photoUri? } | null, onCopyCoords, onCopyNote, onSharePhoto, onEdit, onClose }` — bottom Surface card (styled like TrailInspectPanel), copy buttons hidden when their field is absent, Edit opens the existing editor.
- `WaypointMarkerPin` gains `selected?: boolean` → highlight ring + 1.15 scale.
- MapScreen: `onMapPress` hit → `setViewWp({source,id})` (viewer); Edit button → current `setEditWp` path; copy via `Clipboard.setStringAsync`, photo via existing `Sharing` pattern; snack "Copied" feedback.

- [ ] formatCoords tests → implement → green. `expo install expo-clipboard`.
- [ ] Viewer card + wiring + highlight. `npm run check` green. Commit.

### Task 7: Trail viewer — 3D rail FAB replaces the segmented bar

**Files:**

- Modify: `src/features/map/TrailViewerRail.tsx` (new top FAB `video-3d`, `variant={mode==='3d'?'primary':'surface'}`, a11y "3D relief", onPress toggles `trailViewMode`), `src/features/map/Trail3DGLScreen.tsx` (remove `viewModeBar` SegmentedButtons block + styles).
- Modify: `.maestro/trail-view.yaml` (replace `tapOn: '2D'` / `tapOn: '3D'` with `tapOn: '3D relief'`; the "Notes.\*" 2D assertions follow the toggle).

- [ ] Implement; `npm run check` green. Commit (E2E verified in Task 9).

### Task 8: Drag-and-drop cards onto folder headers

**Files:**

- Create: `src/features/library/useDragToFolder.ts`
- Modify: `src/features/library/LibraryScreen.tsx`

**Interfaces:**

- Produces: `useDragToFolder({ onDrop(kind, itemId, folderId | null) })` returning
  `{ panHandlers(kind, itemId), registerDropTarget(folderId | null) → onLayout ref, dragState: { active, x, y, label } | null, scrollRef }`.
- Behavior: long-press (350 ms) on a card arms the drag (PanResponder claims the responder); an absolutely-positioned ghost chip follows the finger (RN Animated.ValueXY, no re-render per move); folder headers + the Ungrouped header register their measured rects and highlight while hovered; release inside a rect → `onDrop` → `setItemFolder`; release elsewhere cancels. Near top/bottom edges the ScrollView auto-scrolls (`scrollTo` with interval while hovering the edge zones). ScrollView gets `scrollEnabled={!dragState}`.
- Existing ⋮ move-to-folder menu stays untouched.

- [ ] Implement hook + wire map/trail/waypoint cards and headers. Manual on-device verification (Maestro can't drive long-press-drag reliably — spec'd out of E2E). `npm run check` green. Commit.

### Task 9: E2E updates + full suites

**Files:**

- Modify: `.maestro/waypoint.yaml` (pin tap now opens the viewer: assert coordinates text `46\.8.*` + "Copy", tap "Edit" to reach the editor steps), `.maestro/trail-view.yaml` (Task 7), `.maestro/library-filter.yaml` if it brushed bundles (recon says no).
- Add folder-mode coverage to a new `.maestro/folders.yaml`: create folder (Library), move the recorded trail into it via ⋮, Layers→(map overlays untouched) LayersMenu "Folders…" → check the folder → map alive → back to type mode. Wire into `e2e-attempts.sh` before settings.

- [ ] Update flows; run the full suite green on Android emulator and iOS simulator (fresh installs, release builds). Commit.

### Task 10: Release 1.3.0 (vc48)

- [ ] Bump `app.config.ts` 1.2.0→1.3.0 / 47→48 (+ comment lineage), `npm pkg set version=1.3.0`. Commit + push (OTA fires but 1.3.0 lineage has no users yet).
- [ ] Local `eas build --local` AAB (recipe: emulator + simulator off, JVM zombies killed), bundletool launch check + smoke on emulator, `eas submit`, verify internal track shows vc48 "completed" via Play API, delete artifacts.
