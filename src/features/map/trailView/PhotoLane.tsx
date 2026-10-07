import { LANE_CIRCLE, type LaneCircle } from '@core/photos/lane';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { photoLabel } from '../../photos/photoText';
import { photoFileUri } from '../../photos/photoUri';

/** The lane's height: room for the caught circle and its badge. */
export const LANE_H = 46;
const CAUGHT = 38;

/**
 * The photo lane above the elevation profile (#587, mockup 05): a circle per
 * photo (a stack with a count where they would collide), the caught one
 * larger with a sage ring. Tapping a circle opens the viewer on its first
 * photo. Leader lines down to the profile are drawn by the chart (`guides`).
 */
export function PhotoLane({
  circles,
  caughtId,
  onOpen,
}: {
  circles: readonly LaneCircle[];
  /** The cover id of the circle the cursor caught. */
  caughtId: string | null;
  onOpen: (photoId: string) => void;
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.lane} testID="photo-lane">
      {circles.map((c, i) => {
        const caught = c.cover.id === caughtId;
        const size = caught ? CAUGHT : LANE_CIRCLE;
        const count = c.members.length;
        return (
          <Pressable
            key={c.cover.id}
            onPress={() => onOpen(c.cover.id)}
            accessibilityRole="imagebutton"
            accessibilityLabel={
              count > 1
                ? `${count} photos, first: ${photoLabel(c.cover, i + 1)}`
                : `Photo: ${photoLabel(c.cover, i + 1)}`
            }
            hitSlop={4}
            style={[
              styles.circle,
              {
                width: size,
                height: size,
                borderRadius: size / 2,
                left: c.x - size / 2,
                top: LANE_H - size - 2,
                borderColor: caught ? palette.sage : t.surface,
                borderWidth: caught ? 3 : 2,
                zIndex: caught ? 2 : 1,
                shadowColor: palette.shadow,
              },
            ]}
          >
            <Image
              source={{ uri: photoFileUri(c.cover.thumb) }}
              style={[styles.thumb, { borderRadius: size / 2 }]}
            />
            {count > 1 && (
              <View style={[styles.badge, { backgroundColor: t.ink, borderColor: t.surface }]}>
                <Text style={[styles.badgeText, { color: t.surface }]}>
                  {count > 99 ? '99+' : count}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  lane: { height: LANE_H, marginBottom: 2 },
  circle: {
    position: 'absolute',
    shadowOpacity: 0.22,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  thumb: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    top: -6,
    right: -9,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10.5, fontWeight: '800' },
});
