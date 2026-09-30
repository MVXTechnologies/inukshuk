import { formatElevationChange } from '@core/format';
import { unionBoundingBoxes } from '@core/geo/geomath';
import { jobProgress, type ImportJob } from '@core/import/job';
import { sourceLabel } from '@core/import/origin';
import { compactDistance } from '@core/library/libraryRows';
import type { BoundingBox } from '@core/models';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { tabularNums } from '@ui/fonts';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { dismissImportJob, resumeSourceImport, stopSourceImport } from './importController';
import { Card, CountTile, PillButton, ProgressBar, SourceTile } from './importParts';

/**
 * The import job's card at the top of the Library (#432/#435, boards
 * `ImportProgress` and `ImportDone`): progress with a Stop button while it
 * runs (and Strava's rate-limit wait, when it is sitting one out); "Import
 * paused — Resume" after the app was closed mid-import; and the summary with
 * Dismiss / Show on heatmap once it is done. Nothing renders without a job.
 */

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "2 already in your Library · skipped" under the bar; empty when nothing was. */
function skippedLine(job: ImportJob): string {
  const parts: string[] = [];
  if (job.skippedDuplicates > 0) parts.push(`${job.skippedDuplicates} already in your Library`);
  if (job.noGps > 0) parts.push(`${job.noGps} without GPS`);
  if (job.failed > 0) parts.push(`${job.failed} couldn’t load`);
  return parts.length > 0 ? `${parts.join(' · ')} · skipped` : '';
}

function pausedText(job: ImportJob): string {
  switch (job.pausedReason) {
    case 'daily-limit':
      return job.resumeAt
        ? `Strava’s daily limit reached. The import picks up again after ${clock(job.resumeAt)}.`
        : 'Strava’s daily limit reached. Resume it later.';
    case 'background':
      return 'Paused while Inukshuk is in the background.';
    default:
      return 'Inukshuk closed before it finished.';
  }
}

function Notice({ text, bold }: { text: string; bold?: string }) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.notice, { backgroundColor: t.connect.notice }]}>
      <Icon source="clock-outline" size={18} color={t.status.pausedInk} />
      <Text style={[styles.noticeText, { color: t.connect.noticeInk }]}>
        {text}
        {bold ? <Text style={styles.bold}>{bold}</Text> : null}
        {bold ? ' — you can keep using the app.' : null}
      </Text>
    </View>
  );
}

export function ImportJobCard() {
  const job = useImportStore((s) => s.job);
  const t = useSchemeTokens();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);

  // A job waiting out Strava's daily limit picks itself back up while the
  // app is open (after a restart too: the card mounts with the paused job).
  const resumeAt =
    job?.status === 'paused' && job.pausedReason === 'daily-limit' ? job.resumeAt : null;
  useEffect(() => {
    if (resumeAt === null) return;
    const timer = setTimeout(
      () => void resumeSourceImport(),
      Math.max(0, resumeAt - Date.now()) + 1000,
    );
    return () => clearTimeout(timer);
  }, [resumeAt]);

  if (!job) return null;
  // An automatic import stays out of sight until it has something to import.
  if (job.quiet && (job.listing || job.total === 0)) return null;
  const label = sourceLabel(job.source);
  const progressLabel = `${job.done} of ${job.total} activities`;

  if (job.status === 'running' || job.status === 'paused') {
    const running = job.status === 'running';
    const skipped = skippedLine(job);
    return (
      <Card style={styles.card}>
        <View style={styles.body}>
          <View style={styles.headRow}>
            <SourceTile kind={job.source} size={28} />
            <Text style={[styles.headTitle, { color: t.ink }]} numberOfLines={1}>
              {running ? `Importing from ${label}` : 'Import paused'}
            </Text>
            {!job.listing && (
              <Text style={[styles.headCount, { color: t.ink }]}>
                {`${job.done} / ${job.total}`}
              </Text>
            )}
          </View>
          {job.listing ? (
            <Text style={[styles.caption, { color: t.inkMuted }]}>
              {running ? `Getting your ${label} activities…` : pausedText(job)}
            </Text>
          ) : (
            <ProgressBar value={jobProgress(job)} label={progressLabel} />
          )}
          {running && job.pause?.kind === 'rate-limit' && (
            <Notice
              text={`${label}’s rate limit reached. Resuming at `}
              bold={clock(job.pause.resumeAt)}
            />
          )}
          {!running && !job.listing && <Notice text={pausedText(job)} />}
          <View style={styles.footRow}>
            <Text style={[styles.caption, styles.footText, { color: t.inkMuted }]}>{skipped}</Text>
            {!running && job.pausedReason !== 'daily-limit' && (
              <PillButton
                compact
                label="Resume"
                accessibilityLabel="Resume import"
                onPress={() => void resumeSourceImport()}
              />
            )}
            <PillButton
              compact
              label="Stop"
              accessibilityLabel="Stop import"
              onPress={stopSourceImport}
            />
          </View>
        </View>
      </Card>
    );
  }

  if (job.status === 'error') {
    return (
      <Card style={styles.card}>
        <View style={styles.body}>
          <View style={styles.headRow}>
            <SourceTile kind={job.source} size={28} />
            <Text style={[styles.headTitle, { color: t.ink }]}>Import stopped</Text>
          </View>
          <Text style={[styles.caption, { color: t.inkMuted }]}>
            {job.message ?? 'Something went wrong.'}
            {job.imported > 0 ? ` ${plural(job.imported, 'trail', 'trails')} came in first.` : ''}
          </Text>
          <View style={styles.buttons}>
            <PillButton label="Dismiss" onPress={dismissImportJob} />
            {job.errorKind === 'auth' ? (
              <PillButton primary label="Open Settings" onPress={() => router.push('/settings')} />
            ) : (
              <PillButton primary label="Try again" onPress={() => void resumeSourceImport()} />
            )}
          </View>
        </View>
      </Card>
    );
  }

  // Done, or stopped by the user: the summary.
  const done = job.status === 'done';
  const stats = [
    `from ${label}`,
    ...(job.imported > 0
      ? [compactDistance(job.distanceM, units), formatElevationChange(job.ascentM, 'up', units)]
      : []),
    ...(job.failed > 0 ? [`${job.failed} couldn’t load`] : []),
  ].join(' · ');
  return (
    <Card style={styles.card}>
      <View style={[styles.body, styles.doneBody]}>
        <View style={styles.headRow}>
          <View style={[styles.check, { backgroundColor: t.library.onMap }]}>
            <Icon source={done ? 'check' : 'pause'} size={20} color={t.library.onMapInk} />
          </View>
          <View style={styles.doneTitles}>
            <Text style={[styles.doneTitle, { color: t.ink }]}>
              {done
                ? `${plural(job.imported, 'activity', 'activities')} imported`
                : `Import stopped · ${job.done} of ${job.total}`}
            </Text>
            <Text style={[styles.caption, { color: t.inkMuted }]}>{stats}</Text>
          </View>
        </View>
        <View style={styles.tiles}>
          <CountTile value={job.imported} label={job.imported === 1 ? 'new trail' : 'new trails'} />
          <CountTile value={job.skippedDuplicates} label="already here" />
          <CountTile
            value={job.noGps}
            label={job.source === 'strava' ? 'indoor, no GPS' : 'no GPS'}
          />
        </View>
        <View style={styles.buttons}>
          <PillButton label="Dismiss" onPress={dismissImportJob} />
          {done ? (
            job.imported > 0 && <ShowOnHeatmap job={job} />
          ) : (
            <PillButton primary label="Resume" onPress={() => void resumeSourceImport()} />
          )}
        </View>
      </View>
    </Card>
  );
}

/** Turn the heatmap on, frame the imported trails, and go to the map. */
function ShowOnHeatmap({ job }: { job: ImportJob }) {
  const router = useRouter();
  const tracks = useLibraryStore((s) => s.tracks);
  const setSetting = useSettingsStore((s) => s.set);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const onPress = () => {
    const ids = new Set(job.importedTrackIds);
    const boxes: BoundingBox[] = [];
    for (const track of tracks) {
      if (ids.has(track.id) && track.stats.bbox) boxes.push(track.stats.bbox);
    }
    const bounds = unionBoundingBoxes(boxes);
    setSetting('showHeatmap', true);
    if (bounds) setFocusBounds(bounds);
    dismissImportJob();
    router.navigate('/');
  };
  return <PillButton primary label="Show on personal heatmap" onPress={onPress} />;
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.lg, marginTop: space.sm, marginBottom: space.sm },
  body: { padding: space.lg, gap: space.md },
  doneBody: { gap: 14 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headTitle: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '700' },
  headCount: { fontSize: 15, lineHeight: 20, fontWeight: '700', ...tabularNums },
  caption: { fontSize: 13.5, lineHeight: 19 },
  notice: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: space.md,
    borderRadius: 10,
  },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '700' },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  footText: { flex: 1 },
  check: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneTitles: { flex: 1, gap: 2 },
  doneTitle: { fontSize: 18, lineHeight: 23, fontWeight: '700' },
  tiles: { flexDirection: 'row', gap: space.sm },
  buttons: { flexDirection: 'row', gap: 10 },
});
