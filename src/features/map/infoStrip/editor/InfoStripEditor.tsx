import type { AnyExtensionKey } from '@core/extensions/keys';
import { addField, setFieldParams, stripTitle, uniqueName, type Slot } from '@core/infoStrip/edit';
import { editorMaxHeightDp } from '@core/infoStrip/layout';
import { applyPreset, isEditedPreset, type Preset } from '@core/infoStrip/presets';
import { MAX_SAVED_STRIPS } from '@core/infoStrip/settings';
import type { DepsSnapshot, Dock, FieldRef, InfoStrip } from '@core/infoStrip/types';
import { extensionSettingsHref } from '@features/extensions/expansion';
import { useSettingsStore } from '@state/settingsStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Button, Text } from '@ui/paper';

import { ActionSnackbar } from '../../../common/ActionSnackbar';
import { useActionSnackbar } from '../../../common/useActionSnackbar';

import {
  NavRow,
  SectionTitle,
  Segmented,
  SheetNote,
  useSheetAccent,
} from '../../components/mapSheet';
import { PointingLinePanel, PointingLineRow } from '../../components/PointingLinePanel';
import { closeStripEditor } from '../stripRuntime';
import { updateInfoStrip, useInstalledExtensions } from '../stripSettings';
import { CursorSettings, cursorSummary } from './CursorSettings';
import { FieldPicker } from './FieldPicker';
import { FieldSettings } from './FieldSettings';
import { PresetsPage, SaveStripPage } from './PresetsPage';
import { RowsEditor } from './RowsEditor';
import { MAP_OVERLAY_Z } from '../../overlayOrder';
import { useScaledStyles } from '@ui/displayScale';

export type EditorPage =
  | { kind: 'main' }
  | { kind: 'picker'; row: number }
  | { kind: 'field'; at: Slot }
  | { kind: 'cursor' }
  | { kind: 'pointingLine' }
  | { kind: 'presets' }
  | { kind: 'save' }
  | { kind: 'rename'; index: number };

const DOCKS: readonly { value: Dock; label: string }[] = [
  { value: 'bottom', label: 'Bottom' },
  { value: 'top', label: 'Top' },
];

/** The editor's own snackbar (UNDO a delete, the saved-strips limit), ms. */
export const EDITOR_SNACK_MS = 6000;

/** What "Your strips" says at its limit instead of dropping your oldest strip. */
export const SAVED_LIMIT_MESSAGE = `You can keep ${MAX_SAVED_STRIPS} strips. Delete one to save another.`;

/** Where Android Back goes from each page: up one level, then closed. */
function parentPage(page: EditorPage): EditorPage | null {
  switch (page.kind) {
    case 'main':
      return null;
    case 'save':
    case 'rename':
      return { kind: 'presets' };
    default:
      return { kind: 'main' };
  }
}

/**
 * The info strip's editor (mockup §3): the strip lifts into a sheet docked
 * where it lives, over a dimmed map. A plain themed View — never a Paper
 * Portal/Dialog (the One UI touch-swallow) — with its pages in place:
 *
 * - main: Dock (Bottom/Top), the rows as they will look (`RowsEditor`),
 *   "Add a row", then Map aids (centre cursor, pointing line) and Presets;
 * - picker (`FieldPicker`), a field's settings (`FieldSettings`, generated
 *   from its params), the centre cursor, the pointing line (2.5.1's panel),
 *   presets and "your strips", save as / rename.
 *
 * Every change is written at once (the strip's own file, the 2.5.1 mirror
 * when it flips): the strip behind the sheet is the live preview.
 *
 * Modal: Android Back goes up a page, then closes it (only while the map
 * screen is in front: tab screens stay mounted); screen readers stay in the
 * sheet (`accessibilityViewIsModal`; MapScreen hides the map behind it). Its
 * height fits between the status bar and the lifted bottom edge.
 */
export function InfoStripEditor({
  data,
  bottomLift,
  topInset,
  focused = true,
}: {
  data: DepsSnapshot;
  bottomLift: number;
  topInset: number;
  /** The map screen is in front: only then does Android Back belong to the editor. */
  focused?: boolean;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  const router = useRouter();
  const { height } = useWindowDimensions();
  const all = useSettingsStore((s) => s.infoStrip);
  const units = useSettingsStore((s) => s.units);
  const setSetting = useSettingsStore((s) => s.set);
  const installed = useInstalledExtensions();
  const [page, setPage] = useState<EditorPage>({ kind: 'main' });
  const [areaH, setAreaH] = useState<number | null>(null);
  const snack = useActionSnackbar(EDITOR_SNACK_MS);
  const strip = all.current;

  // Android Back: up one page, then closed. Read through a ref, registered once per focus.
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  });
  useEffect(() => {
    if (!focused) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const up = parentPage(pageRef.current);
      if (up === null) closeStripEditor();
      else setPage(up);
      return true;
    });
    return () => sub.remove();
  }, [focused]);
  const full = all.saved.length >= MAX_SAVED_STRIPS;
  const ctx = { units, target: strip.target };
  const edited = isEditedPreset(strip, installed);
  const top = strip.dock === 'top';

  const update = (fn: (s: InfoStrip) => InfoStrip) =>
    updateInfoStrip((a) => ({ ...a, current: fn(a.current) }));
  const setRows = (rows: FieldRef[][]) => update((s) => ({ ...s, rows }));
  const main = () => setPage({ kind: 'main' });

  const applyPresetStrip = (p: Preset) => {
    const next = applyPreset(p, installed);
    update(() => next);
    // A preset carries its pointing line (Survey); the others leave yours as it is.
    if (next.aids.pointingLine !== undefined) setSetting('pointingLine', next.aids.pointingLine);
  };
  const getExtension = (key: AnyExtensionKey) => {
    closeStripEditor();
    router.push(extensionSettingsHref(key));
  };
  const takenNames = all.saved.map((s) => s.name);

  let body: React.ReactNode;
  switch (page.kind) {
    case 'picker':
      body = (
        <FieldPicker
          rows={strip.rows}
          row={page.row}
          installed={installed}
          data={data}
          ctx={ctx}
          onPick={(f) => {
            const rows = addField(strip.rows, page.row, f);
            if (rows !== null) setRows(rows);
            main();
          }}
          onClose={main}
        />
      );
      break;
    case 'field':
      body = (
        <FieldSettings
          strip={strip}
          at={page.at}
          data={data}
          ctx={ctx}
          onParams={(params) => setRows(setFieldParams(strip.rows, page.at, params))}
          onStripTarget={(target) => update((s) => ({ ...s, target }))}
          onBack={main}
        />
      );
      break;
    case 'cursor':
      body = (
        <CursorSettings
          cursor={strip.aids.cursor}
          onChange={(cursor) => update((s) => ({ ...s, aids: { ...s.aids, cursor } }))}
          onBack={main}
        />
      );
      break;
    case 'pointingLine':
      body = <PointingLinePanel onBack={main} backLabel="Back to info strip" />;
      break;
    case 'presets':
      body = (
        <PresetsPage
          current={strip}
          saved={all.saved}
          installed={installed}
          onApplyPreset={applyPresetStrip}
          onApplySaved={(i) => {
            const saved = all.saved[i];
            if (saved === undefined) return;
            update(() => JSON.parse(JSON.stringify(saved)) as InfoStrip);
            // Your strip carries the pointing line it was saved with.
            if (saved.aids.pointingLine !== undefined) {
              setSetting('pointingLine', saved.aids.pointingLine);
            }
          }}
          onSave={() => {
            // At the limit: say so, never drop the oldest strip silently.
            if (full) snack.show(SAVED_LIMIT_MESSAGE);
            else setPage({ kind: 'save' });
          }}
          onRename={(index) => setPage({ kind: 'rename', index })}
          onDuplicate={(i) => {
            if (full) {
              snack.show(SAVED_LIMIT_MESSAGE);
              return;
            }
            updateInfoStrip((a) => {
              const s = a.saved[i];
              if (s === undefined || a.saved.length >= MAX_SAVED_STRIPS) return a;
              const copy = {
                ...s,
                name: uniqueName(
                  s.name,
                  a.saved.map((x) => x.name),
                ),
              };
              return { ...a, saved: [...a.saved.slice(0, i + 1), copy, ...a.saved.slice(i + 1)] };
            });
          }}
          onDelete={(i) => {
            const gone = all.saved[i];
            if (gone === undefined) return;
            updateInfoStrip((a) => ({ ...a, saved: a.saved.filter((_, j) => j !== i) }));
            // A timed UNDO (own timer, never Paper's), not a confirm dialog.
            snack.show(`Deleted “${gone.name}”`, [
              {
                label: 'Undo',
                onPress: () =>
                  updateInfoStrip((a) =>
                    a.saved.length >= MAX_SAVED_STRIPS
                      ? a
                      : {
                          ...a,
                          saved: [
                            ...a.saved.slice(0, i),
                            {
                              ...gone,
                              name: uniqueName(
                                gone.name,
                                a.saved.map((x) => x.name),
                              ),
                            },
                            ...a.saved.slice(i),
                          ],
                        },
                  ),
              },
            ]);
          }}
          onGetExtension={getExtension}
          onBack={main}
        />
      );
      break;
    case 'save':
      body = (
        <SaveStripPage
          title="Save as a strip"
          initialName={uniqueName(strip.name, takenNames)}
          summary={`${strip.rows.flat().length} fields in ${strip.rows.length} row${strip.rows.length === 1 ? '' : 's'}, dock ${strip.dock}, map aids included`}
          onSave={(name) => {
            if (useSettingsStore.getState().infoStrip.saved.length >= MAX_SAVED_STRIPS) {
              snack.show(SAVED_LIMIT_MESSAGE);
              setPage({ kind: 'presets' });
              return;
            }
            updateInfoStrip((a) => {
              // Your own strip now: no "· edited" against a preset.
              const { basedOn: _drop, ...rest } = a.current;
              const mine: InfoStrip = {
                ...rest,
                // Its map aids, the pointing line as it is now included.
                aids: { ...rest.aids, pointingLine: useSettingsStore.getState().pointingLine },
                name: uniqueName(
                  name,
                  a.saved.map((s) => s.name),
                ),
              };
              return {
                ...a,
                current: mine,
                saved: [...a.saved, mine],
              };
            });
            setPage({ kind: 'presets' });
          }}
          onCancel={() => setPage({ kind: 'presets' })}
        />
      );
      break;
    case 'rename': {
      const s = all.saved[page.index];
      body = (
        <SaveStripPage
          title="Rename"
          initialName={s?.name ?? ''}
          summary="Your strip keeps its rows and map aids."
          onSave={(name) => {
            updateInfoStrip((a) => ({
              ...a,
              saved: a.saved.map((x, j) =>
                j === page.index
                  ? {
                      ...x,
                      name: uniqueName(
                        name,
                        a.saved.filter((_, k) => k !== j).map((y) => y.name),
                      ),
                    }
                  : x,
              ),
            }));
            setPage({ kind: 'presets' });
          }}
          onCancel={() => setPage({ kind: 'presets' })}
        />
      );
      break;
    }
    default:
      body = (
        <>
          <View style={styles.dockRow}>
            <Text style={[styles.dockLabel, { color: t.ink }]}>Dock</Text>
            <View style={styles.dockSeg}>
              <Segmented
                levels={DOCKS}
                selected={strip.dock}
                onSelect={(dock) => update((s) => ({ ...s, dock }))}
              />
            </View>
          </View>
          <SectionTitle>{`Rows · ${strip.rows.length} of 3`}</SectionTitle>
          <RowsEditor
            rows={strip.rows}
            data={data}
            ctx={ctx}
            onChange={setRows}
            onOpenField={(at) => setPage({ kind: 'field', at })}
            onAdd={(row) => setPage({ kind: 'picker', row })}
          />
          <SheetNote icon="information-outline">
            Tap a field for its settings · hold to drag · 4 spaces per row, coordinates take 2
          </SheetNote>
          <SectionTitle>Map aids</SectionTitle>
          <NavRow
            icon="image-filter-center-focus"
            label="Centre cursor"
            hint={cursorSummary(strip.aids.cursor)}
            onPress={() => setPage({ kind: 'cursor' })}
          />
          <PointingLineRow onOpen={() => setPage({ kind: 'pointingLine' })} />
          <NavRow
            icon="view-dashboard-variant-outline"
            label="Presets"
            hint={stripTitle(strip, edited)}
            onPress={() => setPage({ kind: 'presets' })}
          />
        </>
      );
  }

  return (
    <>
      <Pressable
        style={[StyleSheet.absoluteFill, styles.dim]}
        onPress={closeStripEditor}
        onLayout={(e) => setAreaH(e.nativeEvent.layout.height)}
        accessibilityLabel="Close the info strip editor"
        accessibilityRole="button"
        testID="strip-editor-backdrop"
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: t.surface,
            borderColor: t.outlineVariant,
            maxHeight: editorMaxHeightDp({
              windowH: height,
              areaH,
              statusBarH: topInset,
              bottomLift,
              dock: strip.dock,
            }),
          },
          top
            ? [styles.sheetTop, { top: 0, paddingTop: topInset }]
            : [styles.sheetBottom, { bottom: bottomLift }],
        ]}
        accessibilityViewIsModal
        testID="strip-editor"
      >
        {page.kind === 'main' && (
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
                Info strip
              </Text>
              <Text style={[styles.subtitle, { color: t.inkMuted }]} numberOfLines={1}>
                {stripTitle(strip, edited)}
              </Text>
            </View>
            <Button
              mode="contained"
              icon="check"
              compact
              buttonColor={accent}
              textColor={onAccent}
              onPress={closeStripEditor}
              accessibilityLabel="Done editing the info strip"
            >
              Done
            </Button>
          </View>
        )}
        <ScrollView
          key={page.kind}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
        >
          {body}
        </ScrollView>
        <ActionSnackbar snack={snack.current} />
      </View>
    </>
  );
}

const stylesSheet = StyleSheet.create({
  dim: { backgroundColor: 'rgba(20,24,28,0.35)', zIndex: MAP_OVERLAY_Z.editorSheet },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: MAP_OVERLAY_Z.editorSheetBody,
    elevation: 12,
    shadowColor: palette.shadow,
    shadowOpacity: 0.25,
    shadowRadius: 12,
  },
  sheetBottom: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowOffset: { width: 0, height: -4 },
  },
  sheetTop: {
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    shadowOffset: { width: 0, height: 4 },
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '800' },
  subtitle: { fontSize: 12.5 },
  body: { paddingBottom: 16 },
  dockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  dockLabel: { fontSize: 15, fontWeight: '600' },
  dockSeg: { flex: 1 },
});
