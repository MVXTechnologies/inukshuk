# Inukshuk UI revamp: approved spec

_Approved by Marc on 2026-09-25 from the design canvas (claude.ai design artifact "Inukshuk UI revamp"). This folder is the implementation handoff. The **HTML boards are the source of truth** for layout, sizes and colours._

- `boards/*.html`: one file per artboard, with exact px, hex and copy. Images are in `boards/blobs/`. Open a board in a browser to see it with the real font (Atkinson Hyperlegible Next from Google Fonts).
- `screens/*.jpg`: quick renders of the boards at 2×. They were rendered **offline with a fallback font**, so text runs wider than in the design; where the two differ, the HTML is right. For example, the TIME and DISTANCE values in `After-Recording.jpg` look like they collide; they don't in the real font.
- `Before-*.html` show the current iOS build, for contrast only.
- `review-2026-09.md`: the full design review with the critique, the rationale and proposals P1–P4, citing file:line in the current code.

Every board is a 390 × 844 pt iPhone frame unless noted. 1 px in a board is 1 dp/pt in React Native.

---

## 0. Decisions Marc made on top of the proposals (these override the review)

1. **Compass: top-left, snug to the safe area.** `top = insets.top + 8`, not lower. It is a stone-92% puck, 48 dp, with a red north tip.
2. **"Go to my position" is a target/crosshair icon, top-right**, first in the right rail. It replaces the blue arrow.
   - Idle: stone-92% puck, paper ink.
   - Following: solid stone, river-blue ink `#8CC4F0`, filled centre dot, `aria-pressed`.
   - Tap toggles follow.
3. **The recording panel has three states and never stops recording when it changes size** (`Recording-States.html`):
   - **A · Mini overlay.** A semi-transparent pill: stone 70% with `blur(14)` backdrop, 52 dp tall, bottom-centre. It shows `● 1:02:14 · 3.42 km` and a chevron. Tap it or swipe up to go to B.
   - **B · Strip** (default when recording starts). Status row, 3 hero fields, then Pause · Mark · hold-to-stop, then "︿ More". The chevron or a swipe down goes to A.
   - **C · Expanded** (second detent). Adds speed, pace, altitude, descent, moving time, time-to-sunset, and the elevation-so-far sparkline. "Less" or a swipe down goes to B.
   - A and B/C are both collapsible and expandable, by chevron **and** by swipe.
4. **Sunlight and Night are opt-in special themes, never automatic by default** (`Display-Modes.html`):
   - Normal (Paper & Stone) is the default.
   - Toggles: "Auto night at sunset" and "Sunlight while recording" (switches on when brightness is at maximum).
   - Entry points: the ⋯ in the recording strip and Settings › Display.
   - Night shows a "Night on · tap to exit" pill.
5. **Loader = the falling-stones Inukshuk.** It is already built on #393 as `src/ui/components/InukshukLoader.tsx`. Use it for every indeterminate wait that has room for it. It replaces the spinner.
6. **Tabs: Map · Library · Maps · Logbook.**
   - There is no Settings tab: Settings is a gear in the Library and Logbook headers, plus a "Settings" row in the map "+" sheet.
   - **Logbook is the old Dashboard.**
   - **Maps is the old "Search" tab (the store).**
7. **Library rows keep the activity type icon.** It is a 20 dp round badge overlapping the bottom-right corner of the 56 dp route thumbnail: paper fill (`#FBF8F2`), with a 1.5 dp ring and glyph in the category colour. The caption also names the type ("Aug 29 · Hike"), and it goes into the accessibility label.

---

## 1. Tokens: `src/ui/tokens.ts` (`After-Tokens.html`)

**Palette**

| Name           | Hex                          |
| -------------- | ---------------------------- |
| stone          | `#2D3740`                    |
| paper          | `#F2ECE0`                    |
| surface        | `#FBF8F2`                    |
| outlineVariant | `#D5CEBF`                    |
| sage           | `#93A25E`                    |
| sageDeep       | `#566B33`                    |
| river          | `#5C93B7`                    |
| puck           | `#2F7FC1`                    |
| granite        | `#8A8B8C`                    |
| graniteDeep    | `#5F6B76`                    |
| ochre          | `#C98A2B`                    |
| amber (status) | `#B45309`                    |
| signalRed      | `#C62828`                    |
| route          | `#E8612C` (casing `#5A1E0B`) |
| muted ink      | `#4A5561`                    |

**Light elevation steps (replace MD3 lavender):** level0 transparent · level1 `#F7F2E8` · level2 `#F3EDE1` · level3 `#EEE7D9` · level4 `#ECE4D5` · level5 `#E8E0CF`.

**Stone night (dark):**

- bg `#13171B` · surface `#1A1F24`
- levels 1–5: `#1F252B` · `#242B32` · `#29313A` · `#2B343D` · `#2F3842`
- outline `#3E4852` · ink `#E9E4D8` · muted `#A7B0B8`

**Sunlight:** surfaces `#FFFFFF`, ink `#000000`, 2 dp outlines on all map chrome, HUD values one step up (32 → 40), route 6 dp with a white casing plus a dark outer casing.

**Night red:**

- bg `#000000` · ink `#FF3B30` · muted `#7A1C17` · deep `#3A0B08`
- No blue or green anywhere.
- Map: `raster-saturation -1`, `raster-brightness-max 0.35`, plus a full-screen `rgba(120,0,0,0.35)` veil with `pointerEvents="none"`.
- Settings points to the iOS Colour Filters for a true red-only screen.

**Semantic layers:**

- `map.chrome` = stone at 92% (`rgba(45,55,64,0.92)`) with paper ink `#F2ECE0` (10.3:1).
- `status.recording` = stone + pulsing red dot.
- `status.paused` = amber bar, a "PAUSED" chip and a hatched strip.
- `status.gpsWeak` = amber outline chip with the text "Weak GPS · ±35 m".
- `status.gpsLost` = red chip with the text "No GPS · 2 min".
- `data.*` covers route, ascent, descent (granite, never red) and pace (dashed).
- `category.*` for hike, run, ski, bike and paddle.
- **Red is reserved for stop, danger and lost GPS.**

**Scale**

|        | Values                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------- |
| space  | 4 · 8 · 12 · 16 · 24 · 32                                                                           |
| radius | 8 · 12 · 16 · 28                                                                                    |
| type   | display 32/700 · title 20/700 · body 16/400 · label 13/700 caps · caption 12/500 (nothing below 12) |
| target | minimum 48 dp (a 36 dp visual gets `hitSlop` 6) · record button 56 dp                               |

**Font:** Atkinson Hyperlegible Next via `expo-font`, with tabular numerals for every number.

**Retire:** app styles Edge and Minimal. Migrate the stored `uiStyle` silently to Classic. Minimal becomes a "Compact map chrome" toggle. That takes the theme count to 4: light, stone night, Sunlight, Night red.

**Guards:**

- A theme test asserts that no token has a hue of 250–300° with saturation above 8% (no purple).
- A contrast matrix over the fg/bg pairs actually used: text ≥ 4.5:1, graphics ≥ 3:1.
- An ESLint rule bans hex literals outside `src/ui/`.

## 2. Map, idle (`Main.html`, `After-Map-Dark.html`)

- **Top row.**
  - Left: compass (48).
  - Middle: **"Search places" pill**, 238 × 48, stone 92%. Phase 1 opens the existing coordinates dialog plus names from local data; a real place index is a later milestone.
  - Right rail, 8 dp gaps: **target**, then a joined stone pill containing **Base map** and **Map overlays (PDF)**, then **"+"**.
  - The "+" sheet holds: waypoint, download area, make a map, coordinates, Settings.
- **Record:** a 64 dp stone circle with a 3 dp paper ring and a white filled dot, plus a "Record" chip under it. It sits bottom-centre, 16 dp above the tab bar. Record leaves the "+" sheet; keep a hidden duplicate until the Maestro flows are migrated.
- **Scale bar** bottom-left and **© OpenStreetMap** bottom-right, both on paper 86% chips.
- **Tab bar:** paper level2 `#F3EDE1`, hairline `#D5CEBF`. The active tab is stone ink plus a 60 × 30 sage pill `#D6DEB8`, with 12/800 labels.
- **Location puck:** river blue `#2F7FC1` with a 3 dp paper ring and a heading cone.

## 3. Recording (`After-Recording.html`, `After-Paused.html`, `After-Recording-Mini.html`, `Recording-States.html`, `After-Targets.html`)

- **Strip B:** 278 dp tall, surface `#FBF8F2`, top radius 24, with a 4 dp stone top bar.
  - **Status row:** a REC chip (stone, red dot) and a GPS chip. Right side: minimize chevron and ⋯, which opens glove lock and display mode.
  - **Three hero fields:** 32/700 tabular values with 12/700 caps labels, divided by `#E3DCCB`. Tap a field to cycle it; the default is Time · Distance · Gain.
  - **Controls:**
    - Pause: flex, 56 dp, stone.
    - Mark: 116 × 56, Inukshuk glyph.
    - Stop: 56 dp, **hold 800 ms with a red ring fill**, and no confirm dialog.
  - **Footer:** "︿ More" and "Hold to stop".
- **Paused:** 6 dp amber top bar, a hatched background, a PAUSED chip, "Paused 4:08" in the footer, and a Resume primary with a paper halo.
- **Weak GPS:** an amber dashed uncertainty circle on the map, plus the amber chip.
- **Tab bar hidden while recording.** If the user leaves the map, show a "Recording, tap to return" pill.
- **Glove lock:** disables map gestures and every button except a long-press to unlock.
- **Keep every existing `accessibilityLabel`** (Stop recording, Pause, Resume, Add waypoint). They are Maestro selectors.

## 4. Display modes (`Display-Modes.html`, `After-Sunlight.html`, `After-Night.html`)

This is a sheet with three large cards (Normal / Sunlight / Night) and the two opt-in toggles listed in decision 4. The settings store gets `condition: 'normal' | 'sunlight' | 'night'`, `autoNightAtSunset` and `sunlightWhileRecording`.

## 5. Library (`After-Library.html`, `After-Empty.html`)

- **Header:** "Library" title, then **Organize**, sort/filter and ⚙ Settings.
- **Chips:** All · Trails · Maps · Waypoints, each with a count.
- **Folders:** collapsible sections with counts. Grips, rename and folder delete appear only in **Organize** mode.
- **Trail row** (76 dp):
  - A 56 dp **route thumbnail**: the route drawn in orange on paper with contour lines and a start dot. Generate it with `react-native-svg` from the simplified track and cache it.
  - The **activity badge** from decision 7.
  - Name (16/700, one line). Stats `11.2 km · 3:31 · ↑1068 m` (14/600, tabular, never truncated). Caption `Aug 29 · Hike`.
  - ⋮ holds everything else. The whole row opens the trail.
- **Map row:** a page-1 thumbnail, a human title ("Charlevoix · 3 pages"), the code and size as the caption, and a sage **"✓ On map"** toggle chip.
- **Waypoint row:** Inukshuk glyph and a note caption.
- **Import** becomes a header "+" menu; nothing may overlap the list.
- **Empty state:** contour texture, Inukshuk, "No trails yet", "Record one on the map, or import a GPX file you already have.", and the buttons [Record a trail] [Import GPX] "Browse maps near you".

## 6. Maps tab (`After-Maps.html`)

- A "Search maps" field.
- A **"Near you · Canadian sources first"** section with NRCan CanTopo sheets sorted by distance, then **"Nearest USGS quads · across the border"**.
- Row: title, source caption, `31 MB · 12 km away` (distance rounded).
- The **Download** button is stone. **Downloaded** is a sage tonal state.
- Footnote: "US Topo covers the United States only."

## 7. Logbook (`After-Logbook.html`)

- The old Dashboard, with a ⚙ Settings button.
- **Lifetime totals:** distance, time and climbed.
- **Distance per week** chart, last 12 weeks, with a Week/Month/Year segment.
- **Activities by type:** Hike, Run, Ski, Bike with counts, using category colour plus a glyph.
- A **Recent** list that uses the same row as Library.

## 8. Gloves and accessibility (`After-Targets.html`)

- Every map and recording target is ≥ 48 dp. Build a `HitTarget` wrapper and a 48 dp `MapButton`, and use them instead of `FAB size="small"`.
- Region-select handles: 32 dp visual, 48 dp hit area.
- **Elevation profile:** add a legend row (Grade · Pace · Avg), draw pace dashed, and never use red for descent.
- Dynamic type:
  - Remove `allowFontScaling={false}` from the compass.
  - Set `maxFontSizeMultiplier` to 1.4 on HUD numbers, and let the strip grow rather than clip.

---

## Suggested PR sequence

Each PR is small enough to review and passes `npm run check`. Base every PR on `main` **after 1.6.0 ships**; the revamp targets **1.7.0**.

1. **Tokens + purple leak.** `tokens.ts`, MD3 overrides from the tokens, no-purple and contrast tests, and the Atkinson font.
2. **Themes collapse.** Drop Edge and Minimal (migrating the stored setting), add the Compact chrome toggle and the hex-literal lint rule.
3. **Tabs + Settings route.** Map · Library · Maps · Logbook. Rename `search`→`maps` and `dashboard`→`logbook`, make Settings a stack route, and update deep links and Maestro flows.
4. **Map chrome.** Compass position, target/follow button, rail regroup, `MapButton` / `HitTarget`, the Search pill (coordinates-first), the idle Record button and the puck.
5. **Recording panel.** States A/B/C with gestures, hold-to-stop, paused and GPS states, and glove lock. Hide the tab bar while recording.
6. **Display modes.** Sunlight and Night red themes, the map paint props per condition, and the Display sheet.
7. **Library.** Rows, route thumbnails, activity badge, chips, Organize mode, header import and empty state.
8. **Maps tab + Logbook** restyle.
9. **Store screenshots**, including one of recording.
