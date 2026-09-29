import { sourceLabel } from '@core/import/origin';
import {
  RANGE_CHOICES,
  importPreviewText,
  planImport,
  resolveRange,
  showsSlowImportNote,
  type RangeChoice,
} from '@core/import/plan';
import {
  SourceStopError,
  rangeStart,
  type ActivitySourceId,
  type RemoteActivity,
} from '@core/import/sources';
import { canImport } from '@core/strava/tokens';
import {
  healthAvailability,
  healthSource,
  openHealthInstall,
  requestHealthPermissions,
  type HealthAvailability,
} from '@lib/health';
import { connectStrava, isStravaConfigured } from '@lib/strava';
import { useImportStore, type ImportSheetSource } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useStravaStore } from '@state/stravaStore';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { sourceFor, startSourceImport } from './importController';
import { PillButton, SourceTile } from './importParts';

/**
 * Library › Import activities (#432/#435, board `ImportSheet`): pick a
 * source (Strava, Apple Health / Health Connect, or files), pick which
 * activities, see how many are new, import. A plain View-based bottom sheet
 * in a transparent Modal — no Paper Portal/Surface (see the project notes on
 * iOS flex collapse and touch-swallowing portals).
 *
 * The preview lists the source cheaply (no routes) and plans it against the
 * Library, so "Import 41" means 41 new activities with GPS; that listing is
 * handed to the importer so nothing is listed twice.
 */

type Preview =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; listed: RemoteActivity[]; count: number }
  | { kind: 'error'; message: string };

const HEALTH_SUBTITLE: Record<'apple-health' | 'health-connect', string> = {
  'apple-health': 'Apple Watch and apps that save routes to Health',
  'health-connect': 'Apps that save routes to Health Connect',
};

function SourceRow({
  kind,
  title,
  subtitle,
  selected,
  selectable,
  busy,
  onPress,
}: {
  kind: ActivitySourceId | 'files';
  title: string;
  subtitle: string;
  selected: boolean;
  /** False: tapping acts (connect, allow, install) instead of selecting. */
  selectable: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole={selectable ? 'radio' : 'button'}
      accessibilityState={selectable ? { checked: selected } : { busy: !!busy }}
      accessibilityLabel={`${title}, ${subtitle}`}
      style={({ pressed }) => [
        styles.sourceRow,
        selected
          ? { borderWidth: 2, borderColor: t.ink, backgroundColor: t.elevation.level1 }
          : { borderWidth: 1, borderColor: t.outlineVariant, backgroundColor: t.surface },
        pressed && styles.pressed,
      ]}
    >
      {selectable ? (
        <Icon
          source={selected ? 'radiobox-marked' : 'radiobox-blank'}
          size={22}
          color={selected ? t.ink : t.inkMuted}
        />
      ) : (
        <Icon source="link-variant" size={22} color={t.inkMuted} />
      )}
      <SourceTile kind={kind} size={32} />
      <View style={styles.sourceText}>
        <Text style={[styles.sourceTitle, { color: t.ink }]}>{title}</Text>
        <Text style={[styles.sourceSubtitle, { color: t.inkMuted }]}>{subtitle}</Text>
      </View>
      {busy && <ActivityIndicator size="small" color={t.ink} />}
    </Pressable>
  );
}

export function ImportSheet({
  visible,
  initialSource,
  onClose,
  onImportFiles,
}: {
  visible: boolean;
  /** Preselect this source (Settings' "Import activities"). */
  initialSource: ImportSheetSource | null;
  onClose: () => void;
  /** Run the file picker flow (the Library's existing import). */
  onImportFiles: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Mounted per opening: every opening starts over (source, range, preview). */}
      {visible && (
        <SheetBody initialSource={initialSource} onClose={onClose} onImportFiles={onImportFiles} />
      )}
    </Modal>
  );
}

function SheetBody({
  initialSource,
  onClose,
  onImportFiles,
}: {
  initialSource: ImportSheetSource | null;
  onClose: () => void;
  onImportFiles: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const connection = useStravaStore((s) => s.connection);
  const lastImportAt = useImportStore((s) => s.lastImportAt);
  const healthAllowed = useImportStore((s) => s.healthAllowed);
  const setHealthAllowed = useImportStore((s) => s.setHealthAllowed);
  const job = useImportStore((s) => s.job);
  const tracks = useLibraryStore((s) => s.tracks);

  const stravaShown = isStravaConfigured();
  const stravaReady = canImport(connection);
  const health = healthSource();
  const healthId = health?.id === 'health-connect' ? 'health-connect' : 'apple-health';
  const [healthState, setHealthState] = useState<HealthAvailability | 'checking'>(
    health ? 'checking' : 'unavailable',
  );
  const [connecting, setConnecting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [selected, setSelected] = useState<ImportSheetSource>(
    () => initialSource ?? (stravaShown && stravaReady ? 'strava' : health ? healthId : 'files'),
  );
  const [choice, setChoice] = useState<RangeChoice>('since-last');
  const [previewState, setPreviewState] = useState<{ key: string; result: Preview } | null>(null);

  useEffect(() => {
    if (!health) return;
    let live = true;
    healthAvailability()
      .then((a) => {
        if (live) setHealthState(a);
      })
      .catch(() => {
        if (live) setHealthState('unavailable');
      });
    return () => {
      live = false;
    };
  }, [health]);

  const healthReady = healthState === 'available' && healthAllowed;
  const sourceReady =
    selected === 'strava' ? stravaReady : selected === 'files' ? false : healthReady;
  const busyJob = job !== null && (job.status === 'running' || job.status === 'paused');
  const last = selected === 'files' ? null : (lastImportAt[selected] ?? null);
  const source = selected === 'files' ? null : sourceFor(selected);
  const previewing = selected !== 'files' && sourceReady && !busyJob && source !== null;
  const previewKey = `${selected}|${choice}|${last ?? ''}|${tracks.length}`;

  // The preview: list cheaply, plan against the Library, count what is new.
  useEffect(() => {
    if (!previewing || !source) return;
    const controller = new AbortController();
    const range = resolveRange(choice, last);
    source
      .list(rangeStart(range, Date.now()), controller.signal)
      .then((listed) => {
        if (controller.signal.aborted) return;
        const plan = planImport(listed, tracks);
        setPreviewState({
          key: previewKey,
          result: { kind: 'ready', listed, count: plan.toFetch.length },
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          err instanceof SourceStopError && err.kind === 'daily-limit'
            ? 'Strava’s daily limit is reached. Try again tomorrow.'
            : err instanceof Error && err.message
              ? err.message
              : 'Couldn’t reach the source';
        setPreviewState({ key: previewKey, result: { kind: 'error', message } });
      });
    return () => controller.abort();
  }, [previewing, source, choice, last, tracks, previewKey]);

  const preview: Preview =
    selected !== 'files' && sourceReady && !busyJob && source === null
      ? { kind: 'error', message: `${sourceLabel(selected)} isn’t available here` }
      : !previewing
        ? { kind: 'idle' }
        : previewState?.key === previewKey
          ? previewState.result
          : { kind: 'loading' };

  const onStravaRow = () => {
    if (stravaReady) {
      setSelected('strava');
      return;
    }
    if (connecting) return;
    setConnecting(true);
    setNote(null);
    connectStrava()
      .then((outcome) => {
        if (!outcome.ok) setNote(outcome.message);
        else if (canImport(useStravaStore.getState().connection)) setSelected('strava');
        else setNote('Strava didn’t allow reading your activities. Connect again and allow it.');
      })
      .catch(() => setNote('Could not connect to Strava'))
      .finally(() => setConnecting(false));
  };

  const onHealthRow = () => {
    if (healthState === 'needs-install') {
      void openHealthInstall();
      return;
    }
    if (healthAllowed) {
      setSelected(healthId);
      return;
    }
    if (asking) return;
    setAsking(true);
    setNote(null);
    requestHealthPermissions()
      .then((outcome) => {
        if (outcome === 'denied') {
          setNote(`Allow Inukshuk to read workouts in ${sourceLabel(healthId)} to import them.`);
          return;
        }
        setHealthAllowed(true);
        setSelected(healthId);
      })
      .catch(() => setNote(`Couldn’t ask ${sourceLabel(healthId)} for access`))
      .finally(() => setAsking(false));
  };

  const onPrimary = () => {
    if (selected === 'files') {
      onClose();
      onImportFiles();
      return;
    }
    if (preview.kind !== 'ready' || preview.count === 0) return;
    const source = selected;
    const range = resolveRange(choice, last);
    onClose();
    void startSourceImport({ source, range, listed: preview.listed });
  };

  const healthSubtitle =
    healthState === 'needs-install'
      ? 'Install Health Connect to import from it'
      : healthAllowed
        ? HEALTH_SUBTITLE[healthId]
        : `Allow access to import · ${HEALTH_SUBTITLE[healthId]}`;
  const healthShown = health !== null && healthState !== 'unavailable';

  const primaryLabel =
    selected === 'files'
      ? 'Choose files'
      : preview.kind === 'ready'
        ? preview.count > 0
          ? `Import ${preview.count.toLocaleString('en-US')}`
          : 'Nothing to import'
        : 'Import';

  const previewText =
    preview.kind === 'ready' && selected !== 'files'
      ? importPreviewText({ count: preview.count, source: selected, choice, lastImportAt: last })
      : null;

  return (
    <View style={styles.modalRoot}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.backdrop }]}
        onPress={onClose}
        accessibilityLabel="Close import"
        accessibilityRole="button"
      />
      <View
        style={[
          styles.sheet,
          { backgroundColor: t.surface, paddingBottom: insets.bottom + space.lg },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: t.outlineVariant }]} />
        <ScrollView contentContainerStyle={styles.content} bounces={false}>
          <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
            Import activities
          </Text>

          <View style={styles.sources} accessibilityRole="radiogroup" accessibilityLabel="Source">
            {stravaShown && (
              <SourceRow
                kind="strava"
                title={stravaReady ? 'Strava' : 'Connect Strava'}
                subtitle={
                  stravaReady
                    ? 'Includes activities synced from Garmin'
                    : connection
                      ? 'Allow reading your activities to import them'
                      : 'Sign in to import your activities'
                }
                selected={selected === 'strava' && stravaReady}
                selectable={stravaReady}
                busy={connecting}
                onPress={onStravaRow}
              />
            )}
            {healthShown && (
              <SourceRow
                kind={healthId}
                title={sourceLabel(healthId)}
                subtitle={healthState === 'checking' ? 'Checking…' : healthSubtitle}
                selected={selected === healthId && healthReady}
                selectable={healthReady}
                busy={asking || healthState === 'checking'}
                onPress={onHealthRow}
              />
            )}
            <SourceRow
              kind="files"
              title="Files"
              subtitle="FIT · GPX · TCX · export zip"
              selected={selected === 'files'}
              selectable
              onPress={() => setSelected('files')}
            />
          </View>

          {note && <Text style={[styles.note, { color: t.status.gpsLostInk }]}>{note}</Text>}

          {selected !== 'files' && sourceReady && (
            <View style={styles.rangeBlock}>
              <Text style={[styles.label, { color: t.inkMuted }]}>WHICH ACTIVITIES</Text>
              <View style={styles.chips}>
                {RANGE_CHOICES.map(({ id, label }) => {
                  const on = choice === id;
                  return (
                    <Pressable
                      key={id}
                      onPress={() => setChoice(id)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      style={[
                        styles.chip,
                        on
                          ? { backgroundColor: t.library.onMap, borderColor: t.library.onMap }
                          : { borderColor: t.outlineVariant },
                      ]}
                    >
                      <Text
                        style={[
                          styles.chipLabel,
                          on
                            ? { color: t.library.onMapInk, fontWeight: '700' }
                            : { color: t.inkVariant },
                        ]}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {selected !== 'files' && sourceReady && (
            <View style={[styles.preview, { backgroundColor: t.background }]}>
              {busyJob ? (
                <Text style={[styles.previewText, { color: t.inkVariant }]}>
                  An import is already under way. Stop it or let it finish first.
                </Text>
              ) : preview.kind === 'loading' ? (
                <>
                  <ActivityIndicator size="small" color={t.ink} />
                  <Text style={[styles.previewText, { color: t.inkVariant }]}>
                    {`Checking ${sourceLabel(selected)}…`}
                  </Text>
                </>
              ) : preview.kind === 'error' ? (
                <Text style={[styles.previewText, { color: t.status.gpsLostInk }]}>
                  {preview.message}
                </Text>
              ) : previewText ? (
                <>
                  <Icon source="information-outline" size={18} color={t.library.onMapBorder} />
                  <Text style={[styles.previewText, { color: t.inkVariant }]}>
                    <Text style={styles.bold}>{previewText.lead}</Text>
                    {previewText.rest}
                    {preview.kind === 'ready' &&
                    showsSlowImportNote(selected, choice, preview.count)
                      ? ' Strava limits how fast apps can read, so this takes a while — it pauses and picks up by itself.'
                      : ''}
                  </Text>
                </>
              ) : null}
            </View>
          )}

          <View style={styles.buttons}>
            <PillButton label="Cancel" onPress={onClose} />
            <PillButton
              primary
              grow={2}
              label={primaryLabel}
              disabled={
                selected !== 'files' && (busyJob || preview.kind !== 'ready' || preview.count === 0)
              }
              onPress={onPrimary}
            />
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 10,
    maxHeight: '92%',
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2 },
  content: { paddingHorizontal: 20, paddingTop: space.xs, gap: 14 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', marginTop: space.xs },
  sources: { gap: space.sm },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 60,
    paddingHorizontal: 14,
    paddingVertical: space.sm,
    borderRadius: 14,
  },
  sourceText: { flex: 1, gap: 2 },
  sourceTitle: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  sourceSubtitle: { fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.7 },
  note: { fontSize: 14, lineHeight: 20 },
  rangeBlock: { gap: space.sm },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 0.3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
  preview: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    paddingVertical: space.md,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  previewText: { flex: 1, fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '700' },
  buttons: { flexDirection: 'row', gap: 10, marginTop: space.xs, minHeight: target.min },
});
