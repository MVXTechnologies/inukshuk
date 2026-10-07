import type { TrackPoint, TrackSummary } from '@core/models';
import { describeClock, stepClockOffset, type ClockStep } from '@core/photos/clock';
import {
  addButtonLabel,
  BY_TIME_TEXT,
  byGpsText,
  clockRows,
  groupCheck,
  importOutcomeMessage,
  outsideText,
  selectedTitle,
  sheetSubtitle,
  thumbStrip,
  thumbsPerRow,
  toggleGroup,
} from '@core/photos/importSheet';
import type { PlannedPhoto } from '@core/photos/placement';
import { photoEditFailureMessage } from '@core/photos/status';
import {
  commitPhotoImport,
  defaultSelection,
  preparePhotoImport,
  type PickedPhoto,
  type PreparedImport,
} from '@data/photos/importPhotos';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { formatDistance } from '@state/formatters';
import { useSettingsStore } from '@state/settingsStore';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Icon, ProgressBar, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PillButton } from '../import/importParts';
import { photoResizer } from './photoResizer';

/**
 * The Add-photos sheet (#587, mockup 4b, DESIGN §4.2). Opening it opens the
 * system photo picker (PHPicker / Android Photo Picker: no library
 * permission); what comes back is matched against the trail and shown in
 * three groups — by time, by location only, not from this outing (unticked)
 * — with the camera-clock check, one line per camera, and an Adjust stepper.
 * "Add N photos" makes the copies (2048 px, or the stripped original with
 * "Full size"), with progress and Cancel.
 *
 * A transparent RN Modal with a plain themed sheet, like the import sheet:
 * never a Paper Portal (touch swallowing) nor an absolutely positioned
 * Surface holding a flex column (iOS collapse). Each opening starts fresh.
 */
export interface AddPhotosSheetProps {
  visible: boolean;
  track: TrackSummary;
  /** The trail's points (the time/GPS placement runs against them). */
  points: readonly TrackPoint[];
  /** Where a ticked "not from this outing" photo without GPS goes (the profile cursor). */
  fallbackDistanceM?: number;
  onClose: () => void;
  /** A one-line result for the screen's snackbar ("Added 33 photos"). */
  onDone: (message: string) => void;
}

export function AddPhotosSheet(props: AddPhotosSheetProps) {
  // Mounted per opening: every opening picks again and starts over.
  return props.visible ? <AddPhotosSession {...props} /> : null;
}

type Phase =
  | { kind: 'picking' }
  | { kind: 'preparing'; count: number }
  | { kind: 'review' }
  | { kind: 'importing'; done: number; total: number };

export const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsMultipleSelection: true,
  selectionLimit: 200,
  exif: true,
  quality: 0.92,
  // iOS: JPEG instead of HEIC. Android re-encodes through Bitmap at quality < 1.
  preferredAssetRepresentationMode:
    ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

function AddPhotosSession({
  track,
  points,
  fallbackDistanceM,
  onClose,
  onDone,
}: AddPhotosSheetProps) {
  const theme = useTheme();
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>({ kind: 'picking' });
  const [picked, setPicked] = useState<PickedPhoto[]>([]);
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // null: the camera clock is estimated; a number: the user's Adjust value.
  const [manualOffsetMs, setManualOffsetMs] = useState<number | null>(null);
  const cancelled = useRef(false);
  const started = useRef(false);
  const pickedRef = useRef<PickedPhoto[]>([]);

  // The picker's cache copies carry their full EXIF (GPS included): they never
  // outlive the sheet, whatever way it closes.
  useEffect(
    () => () => {
      for (const p of pickedRef.current) {
        try {
          if (storage.isCacheUri(p.uri)) storage.deleteFileAt(p.uri);
        } catch {
          // The OS clears its cache.
        }
      }
    },
    [],
  );

  const fail = (err: unknown, fallback: string) => {
    reportError(err, 'add-photos');
    onDone(photoEditFailureMessage(err, fallback));
  };

  const plan = async (photos: PickedPhoto[], offset: number | null) => {
    const next = await preparePhotoImport({
      trackId: track.id,
      points,
      picked: photos,
      ...(offset === null ? {} : { manualClockOffsetMs: offset }),
    });
    setPrepared(next);
    setSelected(defaultSelection(next));
    setPhase({ kind: 'review' });
  };

  // Open the picker once, as the sheet opens.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      let result: ImagePicker.ImagePickerResult;
      try {
        result = await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
      } catch (err) {
        fail(err, 'Could not open your photos');
        return;
      }
      if (result.canceled || result.assets.length === 0) {
        onClose();
        return;
      }
      const photos: PickedPhoto[] = result.assets.map((a) => ({
        uri: a.uri,
        assetId: a.assetId ?? null,
        exif: (a.exif as Record<string, unknown> | null | undefined) ?? null,
        width: a.width,
        height: a.height,
      }));
      pickedRef.current = photos;
      setPicked(photos);
      setPhase({ kind: 'preparing', count: photos.length });
      try {
        await plan(photos, null);
      } catch (err) {
        fail(err, 'Could not read the photos');
      }
    })();
    // Runs once per opening (the session is remounted for the next one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replan = (offset: number | null) => {
    setManualOffsetMs(offset);
    plan(picked, offset).catch((err: unknown) => fail(err, 'Could not read the photos'));
  };

  const add = async () => {
    if (!prepared) return;
    const total = selected.size;
    setPhase({ kind: 'importing', done: 0, total });
    cancelled.current = false;
    try {
      const result = await commitPhotoImport({
        prepared,
        selected,
        resizer: photoResizer,
        newId: storage.newId,
        fallbackDistanceM: fallbackDistanceM ?? 0,
        fullSize: useSettingsStore.getState().photoCopySize === 'full',
        onProgress: (p) => setPhase({ kind: 'importing', done: p.done, total: p.total }),
        isCancelled: () => cancelled.current,
      });
      const outcome: Parameters<typeof importOutcomeMessage>[0] = {
        added: result.added.length,
        failed: result.failed.length,
        chosen: total,
      };
      if (result.stopped) outcome.stopped = result.stopped;
      // Each photo that could not be added is reported (its reason only:
      // no file name, caption or place).
      for (const f of result.failed) reportError(new Error(f.message), 'photo-import-item');
      onDone(importOutcomeMessage(outcome));
    } catch (err) {
      fail(err, 'Could not add the photos');
    }
  };

  const close = () => {
    if (phase.kind === 'importing') {
      cancelled.current = true;
      return;
    }
    onClose();
  };

  if (phase.kind === 'picking') return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.modalRoot}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.backdrop }]}
          onPress={close}
          accessibilityLabel="Close add photos"
          accessibilityRole="button"
        />
        <View
          style={[
            styles.sheet,
            { backgroundColor: t.surface, paddingBottom: insets.bottom + space.lg },
          ]}
          testID="add-photos-sheet"
        >
          <View style={[styles.grabber, { backgroundColor: t.outlineVariant }]} />
          {phase.kind === 'preparing' || !prepared ? (
            <View style={styles.busy}>
              <ActivityIndicator color={t.ink} />
              <Text style={[styles.busyText, { color: t.inkVariant }]}>
                {`Matching ${picked.length === 1 ? 'the photo' : `${picked.length} photos`} against your trail…`}
              </Text>
            </View>
          ) : (
            <Review
              prepared={prepared}
              picked={picked}
              selected={selected}
              onSelected={setSelected}
              manualOffsetMs={manualOffsetMs}
              onAdjust={replan}
              importing={phase.kind === 'importing' ? phase : null}
              onCancel={close}
              onAdd={() => void add()}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const GROUPS = [
  { id: 'byTime', label: 'On the trail, by time' },
  { id: 'byGps', label: 'By location only' },
  { id: 'outside', label: 'Not from this outing' },
] as const;

function Review({
  prepared,
  picked,
  selected,
  onSelected,
  manualOffsetMs,
  onAdjust,
  importing,
  onCancel,
  onAdd,
}: {
  prepared: PreparedImport;
  picked: readonly PickedPhoto[];
  selected: Set<string>;
  onSelected: (next: Set<string>) => void;
  manualOffsetMs: number | null;
  onAdjust: (offset: number | null) => void;
  importing: { done: number; total: number } | null;
  onCancel: () => void;
  onAdd: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const { plan, index } = prepared;
  const timedTrail = index.startMs !== undefined;
  const [adjusting, setAdjusting] = useState(manualOffsetMs !== null);
  // As many thumbnails as fit one row (the last one becomes "+N").
  const [stripW, setStripW] = useState(0);
  const perRow = stripW > 0 ? thumbsPerRow(stripW, THUMB, THUMB_GAP) : 6;
  const uriOf = (p: PlannedPhoto) => prepared.items.get(p.candidate.key)?.picked.uri;
  const describe = {
    byTime: () => BY_TIME_TEXT,
    byGps: (g: readonly PlannedPhoto[]) => byGpsText(g, timedTrail),
    outside: (g: readonly PlannedPhoto[]) => outsideText(g),
  };
  const rows = clockRows(plan, manualOffsetMs !== null);
  const offset = manualOffsetMs ?? plan.clock.offsetMs;
  const step = (s: ClockStep) => onAdjust(stepClockOffset(offset, s));
  const busy = importing !== null;

  return (
    <>
      <ScrollView contentContainerStyle={styles.content} bounces={false}>
        <View>
          <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
            {selectedTitle(picked.length)}
          </Text>
          <Text style={[styles.subtitle, { color: t.inkVariant }]}>
            {sheetSubtitle(index, prepared.duplicates)}
          </Text>
        </View>

        {GROUPS.map(({ id, label }) => {
          const group = plan[id];
          if (group.length === 0) return null;
          const keys = group.map((p) => p.candidate.key);
          const check = groupCheck(keys, selected);
          const { shown, more } = thumbStrip(group, perRow);
          return (
            <View key={id} style={styles.group}>
              <Pressable
                onPress={() => onSelected(toggleGroup(selected, keys))}
                disabled={busy}
                accessibilityRole="checkbox"
                accessibilityLabel={label}
                accessibilityState={{
                  checked: check === 'mixed' ? 'mixed' : check === 'checked',
                  disabled: busy,
                }}
                style={styles.groupHead}
              >
                <Icon
                  source={
                    check === 'checked'
                      ? 'checkbox-marked'
                      : check === 'mixed'
                        ? 'minus-box'
                        : 'checkbox-blank-outline'
                  }
                  size={28}
                  color={check === 'unchecked' ? t.outline : theme.colors.primary}
                />
                <Text style={[styles.groupTitle, { color: t.ink }]}>{label}</Text>
                <Text style={[styles.count, { color: t.ink }]}>{group.length}</Text>
              </Pressable>
              <Text style={[styles.groupText, { color: t.inkVariant }]}>{describe[id](group)}</Text>
              <View style={styles.thumbs} onLayout={(e) => setStripW(e.nativeEvent.layout.width)}>
                {shown.map((p) => {
                  const uri = uriOf(p);
                  return (
                    <View key={p.candidate.key} style={styles.thumbBox}>
                      {uri ? (
                        <Image
                          source={{ uri }}
                          style={[styles.thumb, !selected.has(p.candidate.key) && styles.faded]}
                          accessibilityIgnoresInvertColors
                        />
                      ) : (
                        <View style={[styles.thumb, { backgroundColor: t.surfaceVariant }]} />
                      )}
                      {id === 'byGps' && p.result.kind === 'gps' && (
                        <View style={[styles.distPill, { backgroundColor: t.map.chrome }]}>
                          <Text style={[styles.distText, { color: t.map.chromeInk }]}>
                            {formatDistance(p.result.position.distanceM)}
                          </Text>
                        </View>
                      )}
                    </View>
                  );
                })}
                {more > 0 && (
                  <View style={[styles.thumb, styles.more, { backgroundColor: t.surfaceVariant }]}>
                    <Text style={[styles.moreText, { color: t.ink }]}>{`+${more}`}</Text>
                  </View>
                )}
              </View>
            </View>
          );
        })}

        <View
          style={[styles.clock, { borderColor: t.outlineVariant, backgroundColor: t.background }]}
          testID="camera-clock"
        >
          <View style={styles.clockHead}>
            <Icon source="clock-check-outline" size={26} color={theme.colors.primary} />
            <View style={styles.clockRows}>
              {rows.map((r) => (
                <View key={r.key}>
                  <Text style={[styles.clockTitle, { color: t.ink }]}>{r.title}</Text>
                  <Text style={[styles.clockDetail, { color: t.inkVariant }]}>{r.detail}</Text>
                </View>
              ))}
            </View>
            <Pressable
              onPress={() => setAdjusting((a) => !a)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Adjust camera clock"
              accessibilityState={{ expanded: adjusting }}
              hitSlop={8}
              style={styles.adjust}
            >
              <Text style={[styles.adjustText, { color: theme.colors.primary }]}>
                {adjusting ? 'Done' : 'Adjust'}
              </Text>
            </Pressable>
          </View>
          {adjusting && (
            <View style={styles.stepper}>
              {(['-1h', '-1m'] as const).map((s) => (
                <StepButton key={s} step={s} onPress={() => step(s)} disabled={busy} />
              ))}
              <Text style={[styles.offset, { color: t.ink }]} numberOfLines={2}>
                {describeClock({ status: 'corrected', offsetMs: offset })}
              </Text>
              {(['+1m', '+1h'] as const).map((s) => (
                <StepButton key={s} step={s} onPress={() => step(s)} disabled={busy} />
              ))}
            </View>
          )}
          {adjusting && manualOffsetMs !== null && (
            <Pressable
              onPress={() => onAdjust(null)}
              disabled={busy}
              accessibilityRole="button"
              style={styles.auto}
            >
              <Text style={[styles.adjustText, { color: theme.colors.primary }]}>
                Check it from the photos again
              </Text>
            </Pressable>
          )}
        </View>

        <View style={styles.privacy}>
          <Icon source="shield-lock-outline" size={20} color={t.inkVariant} />
          <Text style={[styles.privacyText, { color: t.inkVariant }]}>
            Inukshuk keeps its own copies on this phone. Your originals stay in your photo library,
            untouched. Nothing is uploaded.
          </Text>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {importing ? (
          <View style={styles.progress} accessibilityLiveRegion="polite">
            <Text style={[styles.progressText, { color: t.ink }]}>
              {`Adding photo ${Math.min(importing.done + 1, importing.total)} of ${importing.total}…`}
            </Text>
            <ProgressBar
              progress={importing.total > 0 ? importing.done / importing.total : 0}
              color={theme.colors.primary}
              style={styles.bar}
            />
          </View>
        ) : null}
        <View style={styles.buttons}>
          <PillButton label="Cancel" onPress={onCancel} />
          {/* Stays in place (disabled) while adding: if it went away, Cancel
              would stretch under the finger and a second tap on "Add" would
              cancel the import (seen in CI: Maestro's retried tap kept one
              photo of two). */}
          <PillButton
            primary
            grow={2}
            label={importing ? 'Adding…' : addButtonLabel(selected.size)}
            disabled={importing !== null || selected.size === 0}
            onPress={onAdd}
          />
        </View>
      </View>
    </>
  );
}

const STEP_LABEL: Record<ClockStep, { text: string; a11y: string }> = {
  '-1h': { text: '−1 h', a11y: 'One hour earlier' },
  '-1m': { text: '−1 min', a11y: 'One minute earlier' },
  '+1m': { text: '+1 min', a11y: 'One minute later' },
  '+1h': { text: '+1 h', a11y: 'One hour later' },
};

function StepButton({
  step,
  onPress,
  disabled,
}: {
  step: ClockStep;
  onPress: () => void;
  disabled: boolean;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={STEP_LABEL[step].a11y}
      style={({ pressed }) => [
        styles.step,
        { borderColor: t.outline },
        (pressed || disabled) && styles.faded,
      ]}
    >
      <Text style={[styles.stepText, { color: t.ink }]}>{STEP_LABEL[step].text}</Text>
    </Pressable>
  );
}

const THUMB = 52;
const THUMB_GAP = 6;

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 10,
    maxHeight: '92%',
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2 },
  busy: { alignItems: 'center', gap: space.md, paddingVertical: space.xxl },
  busyText: { fontSize: 15 },
  content: { paddingHorizontal: 20, paddingTop: space.md, paddingBottom: space.sm, gap: 18 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '800' },
  subtitle: { fontSize: 14, lineHeight: 20, marginTop: 2 },
  group: { gap: 6 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: target.min },
  groupTitle: { flex: 1, fontSize: 17, fontWeight: '800' },
  count: { fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  groupText: { fontSize: 14, lineHeight: 20, marginLeft: 40 },
  thumbs: { flexDirection: 'row', gap: THUMB_GAP, marginLeft: 40, marginTop: 4 },
  thumbBox: { width: THUMB, height: THUMB },
  thumb: { width: THUMB, height: THUMB, borderRadius: 8 },
  faded: { opacity: 0.45 },
  more: { alignItems: 'center', justifyContent: 'center' },
  moreText: { fontSize: 15, fontWeight: '800' },
  distPill: {
    position: 'absolute',
    left: 3,
    bottom: 3,
    paddingHorizontal: 4,
    borderRadius: 6,
  },
  distText: { fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },
  clock: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 10 },
  clockHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  clockRows: { flex: 1, gap: 8 },
  clockTitle: { fontSize: 15, fontWeight: '800' },
  clockDetail: { fontSize: 13, lineHeight: 18 },
  adjust: { minHeight: target.min, justifyContent: 'center' },
  adjustText: { fontSize: 15, fontWeight: '800' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  step: {
    minHeight: target.min,
    minWidth: 52,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  offset: { flex: 1, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  auto: { minHeight: target.min, justifyContent: 'center' },
  privacy: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  privacyText: { flex: 1, fontSize: 13, lineHeight: 19 },
  footer: { paddingHorizontal: 20, paddingTop: space.sm, gap: space.md },
  progress: { gap: 6 },
  progressText: { fontSize: 14, fontWeight: '700' },
  bar: { height: 6, borderRadius: 3 },
  buttons: { flexDirection: 'row', gap: 10, minHeight: target.min },
});
