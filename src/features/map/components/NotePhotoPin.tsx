import type { NotePhotoPinLayout } from '@core/photos/notePins';
import { Image, StyleSheet, View } from 'react-native';

import { NoteNumberBadge } from './NoteNumberBadge';

/**
 * A note with a photo on the trail view's map (#742, "photo ring"): its
 * round sprite — the same circle as every trail photo — with the note's
 * green number on the circle's top-right edge. Centred on the note's point.
 * Visual only: taps are hit-tested at the map level.
 */
export function NotePhotoPin({
  sprite,
  num,
  layout,
}: {
  /** The note photo's round map sprite (`file://`), never the full-size photo. */
  sprite: string;
  num: number;
  layout: NotePhotoPinLayout;
}) {
  const { diameter, badge, badgeX, badgeY } = layout;
  // A square that holds the badge too: a marker's children outside its
  // bounds are clipped on Android.
  const side = Math.ceil(Math.max(diameter, 2 * (Math.max(badgeX, -badgeY) + badge / 2)));
  const c = side / 2;
  return (
    <View style={{ width: side, height: side }} pointerEvents="none" testID="note-photo-pin">
      <Image
        source={{ uri: sprite }}
        style={[
          styles.abs,
          {
            left: c - diameter / 2,
            top: c - diameter / 2,
            width: diameter,
            height: diameter,
            borderRadius: diameter / 2,
          },
        ]}
        accessibilityIgnoresInvertColors
        testID="note-photo-pin-image"
      />
      <View style={[styles.abs, { left: c + badgeX - badge / 2, top: c + badgeY - badge / 2 }]}>
        <NoteNumberBadge num={num} size={badge} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ abs: { position: 'absolute' } });
