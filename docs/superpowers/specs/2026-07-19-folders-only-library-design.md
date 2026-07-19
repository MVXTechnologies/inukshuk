# Folders-only Library, folder map layers, waypoint viewer — design

**Date:** 2026-07-19 · **Target:** 1.3.0
**Decided with the user (2026-07-19):** drop bundles outright; folder-vs-type
map modes are mutually exclusive; waypoints join folders; waypoint tap opens a
read-only viewer with copy actions; both drag-and-drop AND menu-based moves.

## 1. Remove bundles

- Delete the Bundles section, bundle store state/actions, bundle dialogs, and
  the "Add to bundle" card actions. Existing persisted bundles are **dropped**
  (user's call — no migration); the store migration ladder gains a step that
  strips `bundles` from persisted library state.
- The "one tap to light up a trip" job moves to folder visibility (below).

## 2. Folders grow: waypoints + visibility

- `Waypoint` gains `folderId: string | null` (same exclusive model as maps and
  trails). Library waypoint rows get the same move-to-folder affordances.
- Folder membership stays exclusive and flat (no nesting — unchanged).
- New persisted per-folder visibility: `visibleFolderIds: string[]` (plus the
  pseudo-folder `ungrouped`), in the library store.

## 3. Map visibility model (mutually exclusive modes)

The Layers menu's overlay section becomes a **mode choice**:

- **Type mode** (default, current behavior): "PDF" and "Trails" checkboxes
  show everything imported of the checked types.
- **Folder mode**: a "Folders" entry; selecting it deselects PDF/Trails and
  opens a picker dialog listing all folders (+ Ungrouped) with checkboxes —
  the map then shows exactly the union of checked folders (their maps, trails
  AND waypoints). Re-tapping "Folders" reopens the picker.
- Switching back to a type checkbox exits folder mode. One mode is active at
  a time; the active mode + selections persist.

## 4. Waypoint selection viewer (map)

Tapping a waypoint pin no longer opens the editor. Instead a compact viewer
panel (bottom card, not a Portal dialog — see the #108 Portal soft-lock rule)
shows:

- Coordinates (formatted lat/lng),
- the note text (if any), and the photo thumbnail (if any),
- **three copy buttons** — copy coordinates / copy note / copy photo (photo:
  share-sheet via expo-sharing; coordinates and note via expo-clipboard),
- an Edit button that opens the existing editor, and Delete via the editor as
  today.
- Selection must be **obvious**: the selected pin gets a highlight ring +
  size-up while the viewer is open.

## 5. Moving items into folders

- Keep the existing ⋮ menu "Move to folder" flow.
- Add **long-press drag-and-drop**: dragging a card lifts it (reanimated —
  already a dependency); folder headers highlight as drop targets while
  dragging; dropping sets `folderId`. Auto-scroll when dragging near the list
  edges. Waypoint rows draggable the same way.

## Out of scope

Folder nesting, multi-folder membership, folder colors/icons, bulk moves.

## Testing

- Core: store migration (bundle strip), folder visibility selectors,
  waypoint folderId defaulting — unit tests.
- E2E: update flows that touch the Bundles section (none assert it today
  beyond smoke's Library tab pass-through — verify); add folder-mode
  assertions to library-filter or a new flow; waypoint viewer: tap pin →
  coordinates visible → copy note button; drag-and-drop is NOT E2E-automated
  (Maestro long-press-drag across a scrolling list is flake bait) — verified
  manually on-device instead.
- Full suites green on both platforms before release. **1.3.0 is a store
  release (vc48), not an OTA**: expo-clipboard is not yet a dependency and
  adding it is a native change.
