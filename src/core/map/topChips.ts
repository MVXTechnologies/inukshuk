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

import { scaleSize, scaleSpacing } from '@core/display/displayScale';

/** The search pill's slot: its 8 dp top margin + 48 dp height + an 8 dp gap. */
export const SEARCH_SLOT_OFFSET = 8 + 48 + 8;
/** One chip row under another: a 36 dp chip and an 8 dp gap. */
export const CHIP_ROW = 44;

/** The slot and row at a Display size (#760): heights scale, gaps scale as spacing. */
export function searchSlotOffset(factor = 1): number {
  return scaleSpacing(8, factor) + scaleSize(48, factor) + scaleSpacing(8, factor);
}
export function chipRow(factor = 1): number {
  return scaleSize(36, factor) + scaleSpacing(8, factor);
}

export interface TopChipInputs {
  /** The Display size (#760); 1 when omitted. */
  factor?: number;
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
  const k = i.factor ?? 1;
  const gap = scaleSpacing(8, k);
  const row = chipRow(k);
  const lane = i.teamBarHeight > 0 ? gap + i.teamBarHeight + gap : searchSlotOffset(k);
  const onMap = lane + (i.laneTaken ? row : 0);
  return { lane, onMap, receiver: onMap + (i.onMapChip ? row : 0) };
}
