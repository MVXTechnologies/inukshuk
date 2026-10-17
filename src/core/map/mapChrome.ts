/**
 * The map chrome's shared metrics (#756), in dp: one source for the edge
 * columns so mirrored controls line up. The right rail (Locate · Layers · +)
 * and the compass sit {@link MAP_EDGE_INSET} from their edge, one
 * {@link MAP_BUTTON} wide; the team SOS button is a button of that rail's
 * column (its centre on the rail's axis), {@link MAP_STACK_GAP} above the
 * bottom row as the rail's buttons are apart; the top-centre lane (search,
 * team pill, chips) runs between the two columns with a {@link MAP_LANE_GAP}
 * either side.
 *
 * {@link mapChromeAt} gives the same metrics at a Display size (#760).
 *
 * PURE: plain numbers, no React Native.
 */
import { MIN_TOUCH, scaleSize, scaleSpacing } from '@core/display/displayScale';

/** A map button's distance from its screen edge. */
export const MAP_EDGE_INSET = 16;
/** A map button's footprint: its touch box, the glove-sized minimum target. */
export const MAP_BUTTON = 48;
/** The disc a map button draws inside that box (#760: Google Maps' 40 dp). */
export const MAP_BUTTON_DISC = 40;
/** The gap between stacked map buttons (and from the SOS button to the bottom row). */
export const MAP_STACK_GAP = 8;
/** The gap between an edge column and the top-centre lane. */
export const MAP_LANE_GAP = 12;
/** The top-centre lane's inset from either edge: past the column and its gap (76). */
export const MAP_LANE_INSET = MAP_EDGE_INSET + MAP_BUTTON + MAP_LANE_GAP;
/** The rail's axis: a column button's centre, from its edge (40). */
export const MAP_COLUMN_AXIS = MAP_EDGE_INSET + MAP_BUTTON / 2;

/** The map chrome's metrics at a Display size, in dp. */
export interface MapChrome {
  /** Distance of a column's touch boxes from their edge (spacing). */
  edgeInset: number;
  /** A map button's drawn disc. */
  disc: number;
  /** A map button's touch box and footprint: never under 48. */
  button: number;
  /** The visual gap between stacked discs (spacing). */
  stackGap: number;
  /** The gap between stacked touch boxes that leaves the discs `stackGap` apart (0: the boxes touch). */
  railGap: number;
  /** A column button's centre, from its edge: the SOS button shares it. */
  columnAxis: number;
  /** The gap between an edge column and the top-centre lane (spacing). */
  laneGap: number;
  /** The top-centre lane's inset from either edge. */
  laneInset: number;
}

/**
 * The metrics at `factor`, composed from the scaled parts (spacing at
 * factor^1.5, sizes at the factor) so the columns, the lane and the SOS
 * button line up at every size. At 1 they are the constants above, except
 * the rail's gap: the discs are 40 dp in 48 dp boxes, so the boxes touch and
 * the discs stay 8 dp apart.
 */
export function mapChromeAt(factor: number): MapChrome {
  const edgeInset = scaleSpacing(MAP_EDGE_INSET, factor);
  const disc = scaleSize(MAP_BUTTON_DISC, factor);
  const button = Math.max(MIN_TOUCH, scaleSize(MAP_BUTTON, factor));
  const stackGap = scaleSpacing(MAP_STACK_GAP, factor);
  const laneGap = scaleSpacing(MAP_LANE_GAP, factor);
  return {
    edgeInset,
    disc,
    button,
    stackGap,
    railGap: Math.max(0, disc + stackGap - button),
    columnAxis: edgeInset + button / 2,
    laneGap,
    laneInset: edgeInset + button + laneGap,
  };
}

/**
 * At Large the team pill can't fit between the compass and the rail on a
 * 360 dp phone (owner 2026-10-16, option a): it runs from the left edge inset
 * to the rail, and the compass moves just below the team bar.
 */
export function teamPillSpansLeft(factor: number): boolean {
  return factor > 1;
}

/** The team pill's left inset at a Display size. */
export function teamPillLeft(chrome: MapChrome, factor: number): number {
  return teamPillSpansLeft(factor) ? chrome.edgeInset : chrome.laneInset;
}

/** A camera fit's edge padding, px. */
export interface EdgePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * How much room the map chrome takes at a Display size, relative to 100 %:
 * the top lane's inset (edge inset, button, gap) at the size over its 76 dp.
 * Camera paddings follow it, so a fitted shape clears the scaled buttons.
 */
export function chromeScale(factor: number): number {
  return factor === 1 ? 1 : mapChromeAt(factor).laneInset / MAP_LANE_INSET;
}

/** A camera fit's padding, designed at 100 %, at the Display size (#760). */
export function cameraPadding(p: EdgePadding, factor: number): EdgePadding {
  if (factor === 1) return p;
  const k = chromeScale(factor);
  return {
    top: Math.round(p.top * k),
    right: Math.round(p.right * k),
    bottom: Math.round(p.bottom * k),
    left: Math.round(p.left * k),
  };
}

/** The `right` that centres a box `width` wide on the column's axis. */
export function onColumnRight(chrome: MapChrome, width: number): number {
  return chrome.columnAxis - width / 2;
}
