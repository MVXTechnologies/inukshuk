import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Image, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

import type { CaptureToast } from './useRecordingPhoto';

/**
 * "Photo 7 added to this recording · 2.40 km · 732 m · 10:10 · UNDO" (mockup
 * 4a): a card over the map, just above the recording panel. A plain themed
 * View — never a Portal on the recording path — whose dismiss timer is owned
 * by `useRecordingPhoto` (Paper's snackbar timer sticks on One UI).
 */
export function CapturedPhotoToast({
  toast,
  onUndo,
  style,
}: {
  toast: CaptureToast;
  onUndo: () => void;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const t = useSchemeTokens();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: t.elevation.level3, shadowColor: palette.shadow },
        style,
      ]}
      accessibilityLiveRegion="polite"
      testID="captured-photo-toast"
    >
      <Image
        source={{ uri: toast.thumbUri }}
        style={[styles.thumb, { borderColor: t.surface }]}
        accessibilityIgnoresInvertColors
      />
      <View style={styles.text}>
        <Text style={[styles.title, { color: t.ink }]} numberOfLines={1}>
          {toast.title}
        </Text>
        {toast.detail !== '' && (
          <Text style={[styles.detail, { color: t.inkVariant }]} numberOfLines={1}>
            {toast.detail}
          </Text>
        )}
      </View>
      <Pressable
        onPress={onUndo}
        accessibilityRole="button"
        accessibilityLabel="Undo photo"
        hitSlop={8}
        style={styles.undo}
      >
        <Text style={[styles.undoText, { color: theme.colors.primary }]}>UNDO</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 18,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 8,
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  thumb: { width: 44, height: 44, borderRadius: 22, borderWidth: 2 },
  text: { flex: 1, gap: 1 },
  title: { fontSize: 15, fontWeight: '700' },
  detail: { fontSize: 13, fontVariant: ['tabular-nums'] },
  undo: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center' },
  undoText: { fontSize: 15, fontWeight: '800', letterSpacing: 0.6 },
});
