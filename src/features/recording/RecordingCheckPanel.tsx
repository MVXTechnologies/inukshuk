import {
  allClear,
  type ReadinessCheck,
  type ReadinessFix,
} from '@core/recording/recordingReadiness';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Icon, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRecordingReadiness } from './useRecordingReadiness';

export type RecordingCheckMode =
  /** Before a recording starts: "Start recording" proceeds. */
  | 'preflight'
  /** A problem was detected (during or after a recording). */
  | 'review'
  /** Opened from Settings. */
  | 'settings';

interface Props {
  visible: boolean;
  mode: RecordingCheckMode;
  /** What went wrong, shown above the rows (review mode). */
  incident?: string | null;
  /** Preflight's primary action. */
  onStart?: () => void;
  onClose: () => void;
}

const ICONS: Record<ReadinessCheck['status'], string> = {
  ok: 'check-circle',
  problem: 'alert-circle',
  advice: 'alert-circle-outline',
};

function CheckRow({
  check,
  busy,
  onFix,
}: {
  check: ReadinessCheck;
  busy: boolean;
  onFix: (fix: ReadinessFix) => void;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  // ✓ stays neutral; "needs action" is the app's amber (the weak-GPS ink,
  // contrast-checked on level-3 cards in tokens.test); red only for problems
  // that WILL break the trail.
  const tint =
    check.status === 'ok'
      ? theme.colors.primary
      : check.status === 'problem'
        ? theme.colors.error
        : tokens.status.gpsWeak;
  const statusWord =
    check.status === 'ok' ? 'OK' : check.status === 'problem' ? 'Problem' : 'Recommended';
  return (
    <View style={styles.row} testID={`recording-check-${check.id}`}>
      <View style={styles.rowIcon} accessible accessibilityLabel={statusWord}>
        <Icon source={ICONS[check.status]} size={22} color={tint} />
      </View>
      <View style={styles.rowBody}>
        <Text variant="titleSmall">{check.title}</Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {check.detail}
        </Text>
      </View>
      {check.fix !== null && check.fixLabel !== null && (
        <Button
          compact
          mode={check.status === 'problem' ? 'contained' : 'contained-tonal'}
          style={styles.rowButton}
          disabled={busy}
          accessibilityLabel={`${check.fixLabel}: ${check.title}`}
          onPress={() => {
            if (check.fix) onFix(check.fix);
          }}
        >
          {check.fixLabel}
        </Button>
      )}
    </View>
  );
}

/**
 * The Recording check: precise location, screen-off recording, battery and
 * notifications, each with a one-tap fix. Shown before the first recording,
 * whenever a problem is detected (approximate location, GPS that stopped with
 * the screen off), and from Settings.
 *
 * Deliberately NOT a paper `<Portal>`/`<Dialog>`: it sits on the recording
 * path, where paper's entrance animation can leave an invisible
 * touch-swallowing overlay on devices with animations disabled (the #108
 * soft-lock on Samsung One UI). A conditionally mounted absolute overlay has
 * no animation to get stuck. Colours come from the paper theme (light + dark).
 */
export function RecordingCheckPanel({ visible, ...rest }: Props) {
  // Mounted only while visible: the rows are re-read on every opening.
  return visible ? <OpenPanel {...rest} /> : null;
}

function OpenPanel({ mode, incident, onStart, onClose }: Omit<Props, 'visible'>) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { checks, fix } = useRecordingReadiness();
  const [busy, setBusy] = useState(false);

  const runFix = (action: ReadinessFix) => {
    setBusy(true);
    void fix(action).finally(() => setBusy(false));
  };

  const clear = checks !== null && allClear(checks);
  const title = mode === 'preflight' ? 'Before you record' : 'Recording check';
  const intro =
    mode === 'preflight'
      ? 'Make sure your phone records your whole trail, even in your pocket with the screen off.'
      : 'What your phone needs to record your whole trail, screen off included.';

  return (
    <View
      style={[styles.scrim, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}
      testID="recording-check"
    >
      <View style={[styles.card, { backgroundColor: theme.colors.elevation.level3 }]}>
        <ScrollView contentContainerStyle={styles.content} bounces={false}>
          <View style={styles.header}>
            <Icon source="map-marker-check-outline" size={28} color={theme.colors.primary} />
            <Text variant="headlineSmall" style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            <Text
              variant="bodyMedium"
              style={[styles.intro, { color: theme.colors.onSurfaceVariant }]}
            >
              {intro}
            </Text>
          </View>

          {incident ? (
            <View
              style={[styles.incident, { backgroundColor: theme.colors.errorContainer }]}
              testID="recording-check-incident"
            >
              <Icon
                source="map-marker-alert-outline"
                size={20}
                color={theme.colors.onErrorContainer}
              />
              <Text
                variant="bodyMedium"
                style={[styles.incidentText, { color: theme.colors.onErrorContainer }]}
              >
                {incident}
              </Text>
            </View>
          ) : null}

          {checks === null ? (
            <ActivityIndicator style={styles.loading} accessibilityLabel="Checking your phone" />
          ) : (
            <View style={styles.rows}>
              {checks.map((c) => (
                <CheckRow key={c.id} check={c} busy={busy} onFix={runFix} />
              ))}
            </View>
          )}

          {clear ? (
            <Text variant="labelLarge" style={[styles.allSet, { color: theme.colors.primary }]}>
              All set — your phone is ready to record.
            </Text>
          ) : null}
        </ScrollView>

        <View style={styles.actions}>
          {mode === 'preflight' ? (
            <>
              <Button onPress={onClose}>Cancel</Button>
              <Button
                mode="contained"
                onPress={onStart}
                accessibilityLabel="Continue to recording"
                testID="recording-check-start"
              >
                Start
              </Button>
            </>
          ) : (
            <Button mode="contained" onPress={onClose} accessibilityLabel="Close recording check">
              Done
            </Button>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    // Above every piece of map chrome: the control rail's Surfaces carry an
    // Android elevation that otherwise draws them over this scrim (seen on
    // the first E2E screenshot), and zIndex orders it on iOS.
    zIndex: 100,
    elevation: 100,
  },
  card: { borderRadius: 28, maxHeight: '100%', overflow: 'hidden' },
  content: { padding: 24, paddingBottom: 8 },
  header: { alignItems: 'center', marginBottom: 16 },
  title: { textAlign: 'center', marginTop: 8 },
  intro: { textAlign: 'center', marginTop: 6 },
  incident: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderRadius: 16,
    padding: 12,
    marginBottom: 16,
  },
  incidentText: { flex: 1 },
  loading: { marginVertical: 24 },
  rows: { gap: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowIcon: { alignSelf: 'flex-start', paddingTop: 1 },
  rowBody: { flex: 1, gap: 2 },
  rowButton: { alignSelf: 'center' },
  allSet: { textAlign: 'center', marginTop: 20 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 20,
  },
});
