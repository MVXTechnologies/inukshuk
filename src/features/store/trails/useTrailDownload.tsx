import type { CorridorPlan } from '@core/trails/corridor';
import type { TrailDetail } from '@core/trails/schema';
import { formatByteSize } from '@core/storage/diskBudget';
import { useLongTrailsStore } from '@state/longTrailsStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import {
  downloadable,
  downloadTrail,
  planTrailDownload,
  refusalMessage,
  trailDownloadKey,
  trailPacks,
  type TrailDownloadTarget,
} from './trailDownload';

/**
 * One stage's (or a short stage-less trail's) offline download (#472): its
 * size estimate, whether it is downloaded, the progress while it runs (kept
 * in `longTrailsStore`, so the trail page and the map sheet agree), and
 * `start`. Messages (done, refused, failed) go to the caller's snackbar.
 */
export interface TrailDownload {
  plan: CorridorPlan;
  allowed: boolean;
  status: 'idle' | 'downloading' | 'done';
  fraction: number;
  /** Stored bytes when done, else the estimate. */
  bytes: number;
  sizeLabel: string;
  start: () => void;
}

export function useTrailDownload(
  detail: TrailDetail,
  stage: TrailDownloadTarget,
  onMessage: (message: string) => void,
): TrailDownload {
  const plan = useMemo(() => planTrailDownload(detail, stage), [detail, stage]);
  const key = trailDownloadKey(detail.id, stage);
  const running = useLongTrailsStore((s) => (s.download?.key === key ? s.download : null));
  const regions = useOfflineStore((s) => s.regions);
  const packs = useMemo(() => trailPacks(regions, detail.id, stage), [regions, detail.id, stage]);
  const done = running === null && packs.length > 0 && packs.every((p) => p.complete);
  const stored = packs.reduce((sum, p) => sum + p.sizeBytes, 0);

  const start = useCallback(() => {
    const store = useLongTrailsStore.getState();
    if (store.download !== null) {
      onMessage(refusalMessage({ kind: 'busy' }));
      return;
    }
    store.setDownload({ key, fraction: 0 });
    void downloadTrail(
      detail,
      stage,
      plan,
      (fraction) => useLongTrailsStore.getState().setDownload({ key, fraction }),
      (warning) => {
        if (warning !== null) onMessage(warning);
      },
    )
      .then((refusal) =>
        onMessage(
          refusal !== null
            ? refusalMessage(refusal)
            : 'Offline map ready — it works without signal',
        ),
      )
      .catch((err: unknown) => onMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => useLongTrailsStore.getState().setDownload(null));
  }, [detail, stage, plan, key, onMessage]);

  const bytes = done ? stored : plan.bytes;
  return {
    plan,
    allowed: downloadable(detail, stage, plan),
    status: running !== null ? 'downloading' : done ? 'done' : 'idle',
    fraction: running?.fraction ?? 0,
    bytes,
    sizeLabel: formatByteSize(bytes),
    start,
  };
}

/** The round download control of a stage row / the map sheet: ⤓, n %, ✓. */
export function TrailDownloadButton({
  download,
  label,
}: {
  download: TrailDownload;
  /** What is downloaded, for screen readers ("Stage 2, Mauricie"). */
  label: string;
}) {
  const t = useSchemeTokens();
  const { status, fraction } = download;
  return (
    <Pressable
      onPress={download.start}
      disabled={status !== 'idle' || !download.allowed}
      accessibilityRole="button"
      accessibilityLabel={
        status === 'done'
          ? `${label} downloaded`
          : status === 'downloading'
            ? `Downloading ${label}, ${Math.round(fraction * 100)} percent`
            : `Download ${label}, ${download.sizeLabel}`
      }
      accessibilityState={{ disabled: status !== 'idle' || !download.allowed }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        { borderColor: t.explore.accent },
        (pressed || !download.allowed) && styles.dim,
      ]}
    >
      {status === 'downloading' ? (
        <View style={styles.progress}>
          <ActivityIndicator size={14} color={t.explore.accent} />
          <Text style={[styles.pct, { color: t.explore.accent }]}>
            {Math.round(fraction * 100)}%
          </Text>
        </View>
      ) : (
        <Icon
          source={status === 'done' ? 'check' : 'download'}
          size={20}
          color={t.explore.accent}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dim: { opacity: 0.5 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  pct: { fontSize: 12, lineHeight: 16, fontWeight: '800' },
});
