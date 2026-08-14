import { marinePackOfferMessage, type MarinePackOffer } from '@core/geo/marinePacks';
import { formatBytes } from '@lib/format';
import { StyleSheet, View } from 'react-native';
import { Icon, Surface, Text, TouchableRipple } from 'react-native-paper';

import { weatherChrome as wc } from '../weather/weatherChrome';

/**
 * The low-resolution marine prompt (marine wave D §D4, the owner's explicit
 * ask: "offer to download a free local marine map"). A QUIET bottom banner —
 * a plain themed Surface in `MapScreen`'s bottom stack, wearing the same
 * fixed dark map chrome as the legend and the readout chip.
 *
 * Deliberately NOT a Dialog and NOT inside a Portal: launch-path Portals
 * soft-lock One UI with an invisible touch-swallowing overlay (see
 * `MarineDisclaimerChip`'s own note), and a modal for a nice-to-have
 * download would be obnoxious anyway. It offers, it never insists: "Not now"
 * snoozes the region for 30 days, and the trigger itself
 * (`marinePackOffer`) only fires where a pack would genuinely beat what is
 * already on screen.
 *
 * While a download runs the banner stays put and becomes its own progress
 * readout, so the user never loses the thing they just tapped.
 */
export function MarinePackBanner({
  offer,
  progress,
  onDownload,
  onDismiss,
}: {
  offer: MarinePackOffer;
  /** Cells done / total while a download runs, else null. */
  progress: { done: number; total: number } | null;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  const busy = progress !== null;
  const size = formatBytes(offer.bytes);
  const detail = busy
    ? `Downloading ${progress.done} of ${progress.total}`
    : `${size} · ${offer.source.label} · ${offer.partial ? 'centre of view' : 'works offline'}`;

  return (
    <Surface style={styles.card} elevation={3} accessibilityLabel="Marine chart pack">
      <View style={styles.row}>
        <View style={styles.iconWrap}>
          <Icon source={busy ? 'progress-download' : 'map-marker-down'} size={18} color={wc.ink} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.title} numberOfLines={2}>
            {marinePackOfferMessage(offer)}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        </View>
      </View>
      {progress !== null ? (
        <View style={styles.track}>
          <View style={[styles.trackFill, { flex: Math.max(0.03, progress.done) }]} />
          <View style={[styles.trackRest, { flex: Math.max(0, progress.total - progress.done) }]} />
        </View>
      ) : (
        <View style={styles.actions}>
          <TouchableRipple
            onPress={onDismiss}
            style={styles.ghostButton}
            accessibilityLabel="Not now"
            accessibilityRole="button"
          >
            <Text style={styles.ghostLabel}>Not now</Text>
          </TouchableRipple>
          <TouchableRipple
            onPress={onDownload}
            style={styles.primaryButton}
            accessibilityLabel="Download chart pack"
            accessibilityRole="button"
          >
            <Text style={styles.primaryLabel}>Download</Text>
          </TouchableRipple>
        </View>
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: wc.panelSolid,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: wc.hairline,
  },
  copy: { flex: 1, gap: 1 },
  title: { fontSize: 13, lineHeight: 17, fontWeight: '700', color: wc.ink },
  detail: { fontSize: 11, lineHeight: 15, color: wc.inkMuted, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  ghostButton: { borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7 },
  ghostLabel: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: wc.inkMuted },
  primaryButton: {
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: wc.accent,
  },
  primaryLabel: { fontSize: 12, lineHeight: 16, fontWeight: '700', color: wc.onAccent },
  track: { flexDirection: 'row', height: 3, borderRadius: 2, overflow: 'hidden' },
  trackFill: { backgroundColor: wc.accent },
  trackRest: { backgroundColor: wc.hairline },
});
