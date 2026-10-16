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
 * PURE: plain numbers, no React Native.
 */

/** A map button's distance from its screen edge. */
export const MAP_EDGE_INSET = 16;
/** A map button's size (the glove-sized minimum target). */
export const MAP_BUTTON = 48;
/** The gap between stacked map buttons (and from the SOS button to the bottom row). */
export const MAP_STACK_GAP = 8;
/** The gap between an edge column and the top-centre lane. */
export const MAP_LANE_GAP = 12;
/** The top-centre lane's inset from either edge: past the column and its gap (76). */
export const MAP_LANE_INSET = MAP_EDGE_INSET + MAP_BUTTON + MAP_LANE_GAP;
/** The rail's axis: a column button's centre, from its edge (40). */
export const MAP_COLUMN_AXIS = MAP_EDGE_INSET + MAP_BUTTON / 2;
