/**
 * Whether the map's bottom-card slot (waypoint viewer, survey-mark card,
 * tide-station card, forecast card) may show a card right now.
 *
 * A rail sheet (map type, overlays, "+" actions) owns the screen while it is
 * open: the cards used to draw OVER the Overlays sheet. They now step aside
 * while a sheet is open — hidden, not dismissed, so the same card is back
 * when the sheet closes — as they already do for a trail inspection, a
 * waypoint edit or a drawing tool.
 */
export interface BottomCardSlotInput {
  railMenuOpen: boolean;
  inspecting: boolean;
  editingWaypoint: boolean;
  drawing: boolean;
}

export function bottomCardSlotFree(s: BottomCardSlotInput): boolean {
  return !s.railMenuOpen && !s.inspecting && !s.editingWaypoint && !s.drawing;
}
