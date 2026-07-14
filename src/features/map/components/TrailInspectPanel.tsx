import { haversineMeters, type TrackPointAt } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import { formatDistance } from '@lib/format';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Dialog, IconButton, Portal, Surface, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ElevationProfile } from '../../common/components/ElevationProfile';
import { TrimRangeSlider } from './TrimRangeSlider';

export interface TrimRange {
  start: number;
  end: number;
}

interface Props {
  track: TrackSummary;
  points: readonly TrackPoint[];
  onClose: () => void;
  /** Scrub position along the profile (drives the on-map marker). */
  onScrub: (at: TrackPointAt | null) => void;
  /** Kept [start, end] point window while trimming, or null when not trimming. */
  trim: TrimRange | null;
  onBeginTrim: () => void;
  onCancelTrim: () => void;
  onChangeTrim: (start: number, end: number) => void;
  /** Persist the kept segment as a new trail; the original stays. */
  onSaveTrimCopy: () => void;
  /** Replace this trail's GPX with the kept segment. */
  onOverwriteTrim: () => void;
  /** Disables the trim actions while a save is in flight. */
  trimSaving: boolean;
}

/**
 * Bottom sheet for the inspected trail: its scrubbable elevation profile, plus
 * a "Trim" mode where two handles shorten the track from either end with a live
 * preview on the map. Trimming replaces the profile with the range slider and
 * save actions; Overwrite asks for confirmation.
 */
export function TrailInspectPanel({
  track,
  points,
  onClose,
  onScrub,
  trim,
  onBeginTrim,
  onCancelTrim,
  onChangeTrim,
  onSaveTrimCopy,
  onOverwriteTrim,
  trimSaving,
}: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  // Cumulative distance at each point — O(n) once per trail, then the kept
  // distance readout is a subtraction per slider move.
  const cumM = useMemo(() => {
    const out = new Array<number>(points.length);
    let d = 0;
    for (let i = 0; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      if (i > 0 && prev && cur) d += haversineMeters(prev, cur);
      out[i] = d;
    }
    return out;
  }, [points]);

  const keptM = trim ? (cumM[trim.end] ?? 0) - (cumM[trim.start] ?? 0) : 0;
  const totalM = cumM.length > 0 ? (cumM[cumM.length - 1] ?? 0) : 0;
  const canTrim = points.length >= 3;

  return (
    <Surface style={[styles.inspectPanel, { paddingBottom: insets.bottom + 8 }]} elevation={4}>
      <View style={styles.inspectHeader}>
        <Text variant="titleSmall" numberOfLines={1} style={styles.inspectTitle}>
          {trim ? `Trim — ${track.name}` : track.name}
        </Text>
        <View style={styles.headerActions}>
          {!trim && canTrim && (
            <IconButton
              icon="content-cut"
              size={20}
              onPress={onBeginTrim}
              accessibilityLabel="Trim trail"
            />
          )}
          <IconButton
            icon="close"
            size={20}
            onPress={onClose}
            accessibilityLabel="Close trail inspector"
          />
        </View>
      </View>

      {trim ? (
        <View style={styles.trimBody}>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Drag the handles to shorten the trail from either end. The highlighted segment is kept.
          </Text>
          <TrimRangeSlider
            count={points.length}
            start={trim.start}
            end={trim.end}
            onChange={onChangeTrim}
          />
          <Text variant="labelMedium">
            Keeping {formatDistance(keptM)} of {formatDistance(totalM)} ·{' '}
            {trim.end - trim.start + 1} of {points.length} points
          </Text>
          <View style={styles.trimActions}>
            <Button onPress={onCancelTrim} disabled={trimSaving}>
              Cancel
            </Button>
            <View style={styles.trimSaveActions}>
              <Button
                mode="outlined"
                icon="content-save-plus-outline"
                onPress={onSaveTrimCopy}
                disabled={trimSaving}
                loading={trimSaving}
              >
                Save as copy
              </Button>
              <Button
                mode="contained"
                icon="content-save-outline"
                onPress={() => setConfirmOverwrite(true)}
                disabled={trimSaving}
              >
                Overwrite
              </Button>
            </View>
          </View>
        </View>
      ) : (
        <ElevationProfile
          points={points}
          ascentM={track.stats.ascentM}
          descentM={track.stats.descentM}
          onScrub={onScrub}
        />
      )}

      <Portal>
        <Dialog visible={confirmOverwrite} onDismiss={() => setConfirmOverwrite(false)}>
          <Dialog.Title>Overwrite trail</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {`Replace "${track.name}" with the trimmed segment? The cut portions (and any notes on them) are permanently removed.`}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmOverwrite(false)}>Cancel</Button>
            <Button
              textColor={theme.colors.error}
              onPress={() => {
                setConfirmOverwrite(false);
                onOverwriteTrim();
              }}
            >
              Overwrite
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Surface>
  );
}

const styles = StyleSheet.create({
  inspectPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 4,
  },
  inspectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 14,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  inspectTitle: { flexShrink: 1, fontWeight: '700' },
  trimBody: { paddingHorizontal: 14, paddingBottom: 6, gap: 6 },
  trimActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  trimSaveActions: { flexDirection: 'row', gap: 8 },
});
