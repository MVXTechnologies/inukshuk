import {
  WAYPOINT_PIN_DIAMETER,
  pinGeometry,
  waypointFill,
  waypointInk,
  waypointRing,
  waypointSize,
} from '@core/library/waypointStyle';
import type { StoredWaypointIcon, WaypointSize } from '@core/models';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { InukshukGlyph } from '@ui/components/InukshukGlyph';
import { palette } from '@ui/tokens';
import { StyleSheet, View } from 'react-native';

import { mciGlyph } from '../components/waypointGlyph';

interface Props {
  icon?: StoredWaypointIcon;
  color?: string;
  size?: WaypointSize;
  /** Override the size's diameter (dp), e.g. to fit a tile. */
  diameter?: number;
}

/**
 * A waypoint pin drawn with plain Views (#675): the editor's live preview,
 * its size row and the move overlay's centre pin (#676). It is the same shape
 * and the same colour rules as the map's SDF symbols (`@core/map/
 * waypointPinStyle`) — a disc with one sharp corner pointing down, a 2 dp
 * ring, the glyph in the ink that keeps 3:1 — so what the editor shows is
 * what the map draws. Its bottom edge is the tip.
 *
 * Decorative: the caller names it for screen readers.
 */
export function WaypointPinView({ icon, color, size, diameter }: Props) {
  const d = diameter ?? WAYPOINT_PIN_DIAMETER[waypointSize(size)];
  const { width, height } = pinGeometry(d);
  const ink = waypointInk(color);
  const glyph = mciGlyph(icon);
  const glyphSize = Math.round(d * 0.56);
  return (
    <View
      style={{ width, height }}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <View
        style={[
          styles.head,
          {
            width: d,
            height: d,
            borderRadius: d / 2,
            backgroundColor: waypointFill(color),
            borderColor: waypointRing(color),
          },
        ]}
      >
        <View style={styles.upright}>
          {glyph === null ? (
            <InukshukGlyph size={glyphSize} frame="square" tone="mono" color={ink} />
          ) : (
            <MaterialCommunityIcons name={glyph} size={glyphSize} color={ink} />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // A square with three round corners, turned so the sharp one points down:
  // its centre sits d·√2/2 above the tip, which is the view's bottom edge.
  head: {
    position: 'absolute',
    top: 0,
    left: 0,
    borderBottomLeftRadius: 0,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-45deg' }],
    shadowColor: palette.black,
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  upright: { transform: [{ rotate: '45deg' }] },
});
