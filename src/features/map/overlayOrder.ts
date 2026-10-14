/**
 * The map screen's overlay stack, bottom up (#673 review): ONE documented
 * order for everything MapScreen draws over the map, as `LIVE_LAYER_ORDER`
 * is for the map's own layers.
 *
 * How React Native stacks siblings: by `zIndex`, then by tree order (a later
 * sibling draws over an earlier one). Android sorts by elevation before both,
 * so an overlay's OUTERMOST view carries no elevation unless this table gives
 * it one (the scrims at {@link MAP_OVERLAY_Z.modal} do, to beat the control
 * rail's Surfaces). Shadows go on inner views.
 *
 * Bottom up:
 *
 * | layer            | zIndex | who                                                    |
 * | ---------------- | ------ | ------------------------------------------------------ |
 * | map              | 0      | MapLibre, the wind particles, the centre cursor        |
 * | infoStrip        | 0      | the docked strip: mounted RIGHT AFTER the map (tree    |
 * |                  |        | order), so every later sibling draws over it           |
 * | chrome / sheets  | 0      | region select, map maker, compass, search pill, chips, |
 * |                  |        | rail, banners, the bottom column, the trail inspector, |
 * |                  |        | the night veil, the glove shield, the category sheet,  |
 * |                  |        | the credits sheet, the drawing tools' chrome: by tree  |
 * |                  |        | order, all above the strip                             |
 * | shownTrailSheet  | 4      | a long trail shown from Explore                        |
 * | topChip          | 5      | the top-centre lane (destination, night, receiver)     |
 * | recordingPanel   | 6      | the recording panel's dock (above the glove shield:    |
 * |                  |        | its hold-to-unlock stays live)                         |
 * | waypointCard     | 7      | the bottom cards: a waypoint's, a cluster's list       |
 * |                  |        | (2.5.2), a team point's, a photo's, an extension's;    |
 * |                  |        | docked ON a bottom strip (`waypointCardDockStyle`)     |
 * | snackbar         | 8      | confirmations, EDIT / UNDO                             |
 * | moveOverlay      | 9      | moving a waypoint owns the screen                      |
 * | teamPick         | 9      | picking a teammate's point                             |
 * | drawingMode      | 9      | team drawing mode (#683, 2.5.2): its canvas and bars   |
 * |                  |        | own the screen; the strip is hidden while it is on     |
 * | overDrawMode     | 10     | a sheet opened from drawing mode (the map credits)     |
 * | heatCarousel     | 10     | the heat-spot activity carousel                        |
 * | searchSheet      | 20     | the open place search                                  |
 * | editorSheet      | 30     | the waypoint editor, the info strip editor (its dim at |
 * |                  |        | 30, its sheet at 31)                                   |
 * | modal            | 100    | the recording check, the background-location rationale |
 *
 * The strip is the LOWEST overlay because it is a passive readout docked to
 * an edge every sheet also uses: a sheet that opens over it (the category
 * picker's Start, the trail inspector, the glove shield) must win. It stays
 * at zIndex 0 and is placed by tree order, because many sheets carry no
 * zIndex of their own and rely on tree order — a strip with any zIndex would
 * draw over all of them (the 2.6.0 review's P0). `overlayOrder.guard.test`
 * pins both halves: the table and MapScreen's mount order.
 *
 * A layer that owns the whole screen (team drawing, a waypoint move) also
 * hides the strip, so a top-docked strip does not push its top bar down and
 * a bottom one lifts nothing under it.
 *
 * To add a layer: add it here with its zIndex, give its outermost view
 * `MAP_OVERLAY_Z.<layer>`, and list its MapScreen marker in the guard test's
 * `ABOVE_THE_STRIP`.
 */
export const MAP_OVERLAY_Z = {
  map: 0,
  infoStrip: 0,
  chrome: 0,
  shownTrailSheet: 4,
  topChip: 5,
  recordingPanel: 6,
  waypointCard: 7,
  snackbar: 8,
  moveOverlay: 9,
  teamPick: 9,
  drawingMode: 9,
  overDrawMode: 10,
  heatCarousel: 10,
  searchSheet: 20,
  editorSheet: 30,
  /** The info strip editor's sheet, over its own dim (`editorSheet`). */
  editorSheetBody: 31,
  modal: 100,
} as const;

export type MapOverlayLayer = keyof typeof MAP_OVERLAY_Z;
