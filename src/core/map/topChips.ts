/**
 * The map's top-centre chip rows (2.6.1): where each row sits below the
 * search slot, measured from the safe-area top.
 *
 * - **The slot:** the "Search places" pill (8 dp margin + 48 dp + 8 dp gap),
 *   or in team mode the team status bar with its chip row under it (#707),
 *   whose measured height replaces the pill's.
 * - **The lane:** the first row under the slot holds one of the marine
 *   notice, the destination readout, the "Following" chip or the night pill.
 * - **On map (#710):** the shown trail's chip, one row lower when the lane is
 *   taken, so it never sits under the team bar's chips nor under the lane.
 * - **Receiver:** the external-receiver chip, below everything above.
 */

/** The search pill's slot: its 8 dp top margin + 48 dp height + an 8 dp gap. */
export const SEARCH_SLOT_OFFSET = 8 + 48 + 8;
/** One chip row under another. */
export const CHIP_ROW = 44;

export interface TopChipInputs {
  /** The team bar's measured column height (pill + its chip row); 0 when it is not shown. */
  teamBarHeight: number;
  /** The lane holds a chip (marine, destination, following, night). */
  laneTaken: boolean;
  /** The "On map" trail chip is up. */
  onMapChip: boolean;
}

export interface TopChipLayout {
  /** The lane's top. */
  lane: number;
  /** The "On map" chip's top. */
  onMap: number;
  /** The receiver chip's top. */
  receiver: number;
}

/** Each top-centre row's offset from the safe-area top (see the module doc). */
export function topChipLayout(i: TopChipInputs): TopChipLayout {
  const lane = i.teamBarHeight > 0 ? 8 + i.teamBarHeight + 8 : SEARCH_SLOT_OFFSET;
  const onMap = lane + (i.laneTaken ? CHIP_ROW : 0);
  return { lane, onMap, receiver: onMap + (i.onMapChip ? CHIP_ROW : 0) };
}
