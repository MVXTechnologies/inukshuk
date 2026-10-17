import type { AnyExtensionKey } from '@core/extensions/keys';
import { extensionBasics } from '@core/extensions/registry';
import { stripTitle } from '@core/infoStrip/edit';
import {
  isEditedPreset,
  missingExtensions,
  presetAidsSummary,
  PRESETS,
  type Preset,
} from '@core/infoStrip/presets';
import { sampleValue } from '@core/infoStrip/preview';
import { captionPlan } from '@core/infoStrip/subject';
import { fieldDescriptor } from '@core/infoStrip/registry';
import type { InfoStrip } from '@core/infoStrip/types';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Button, Icon, Text } from '@ui/paper';

import { SectionTitle, SheetNote, SubPanelHeader, useSheetAccent } from '../../components/mapSheet';
import { StripField } from '../StripField';
import { useScaledStyles } from '@ui/displayScale';

/** A strip's rows drawn from the fields' samples (a real miniature, mockup §6). */
function Miniature({
  strip,
  installed,
}: {
  strip: InfoStrip;
  installed: ReadonlySet<AnyExtensionKey>;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const shown = (f: InfoStrip['rows'][number][number]) => {
    const d = fieldDescriptor(f.field);
    return d === undefined || (d.requires !== undefined && !installed.has(d.requires))
      ? undefined
      : d;
  };
  // The samples' target named once, as the strip names a live one.
  const captions = captionPlan(
    strip.rows.map((row) =>
      row.map((f) => {
        const d = shown(f);
        return d === undefined ? null : sampleValue(d, units);
      }),
    ),
  );
  return (
    <View style={[styles.mini, { backgroundColor: t.surfaceVariant }]}>
      {strip.rows.map((row, r) => (
        <View key={r} style={styles.miniRow}>
          {row.map((f, i) => {
            const d = shown(f);
            if (d === undefined) return null;
            return (
              <View key={`${f.field}-${i}`} style={[styles.miniCell, { flex: d.spaces }]}>
                <StripField
                  value={sampleValue(d, units)}
                  shrink
                  muted
                  fit
                  caption={captions[r]?.[i] ?? false}
                />
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/**
 * Presets (mockup §6): the five built-in strips as real miniatures, the one
 * in use ticked; a tap applies one right away (its map aids too). A preset
 * whose fields need an extension you do not have applies without them and
 * says "Needs … · Get" (never greyed out). Then "Your strips": apply,
 * rename, duplicate, delete; and "Save the current strip…".
 */
export function PresetsPage({
  current,
  saved,
  installed,
  onApplyPreset,
  onApplySaved,
  onSave,
  onRename,
  onDuplicate,
  onDelete,
  onGetExtension,
  onBack,
}: {
  current: InfoStrip;
  saved: readonly InfoStrip[];
  installed: ReadonlySet<AnyExtensionKey>;
  onApplyPreset: (p: Preset) => void;
  onApplySaved: (index: number) => void;
  onSave: () => void;
  onRename: (index: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onGetExtension: (key: AnyExtensionKey) => void;
  onBack: () => void;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const { accent } = useSheetAccent();
  const [menu, setMenu] = useState<number | null>(null);
  const edited = isEditedPreset(current, installed);

  return (
    <View>
      <SubPanelHeader title="Presets" backLabel="Back to info strip" onBack={onBack} />
      <SheetNote icon="gesture-tap">
        Tap to apply. Your edits stay as “· edited” until you save them.
      </SheetNote>
      {PRESETS.map((p) => {
        const on = current.basedOn === p.id && !edited;
        const missing = missingExtensions(p.strip, installed);
        return (
          <Pressable
            key={p.id}
            onPress={() => onApplyPreset(p)}
            accessibilityRole="button"
            accessibilityLabel={`Preset ${p.name}`}
            accessibilityHint={p.summary}
            accessibilityState={{ selected: on }}
            style={[styles.card, { borderColor: on ? accent : t.outlineVariant }]}
            testID={`strip-preset-${p.id}`}
          >
            <View style={styles.cardHead}>
              <View style={styles.cardText}>
                <Text style={[styles.cardName, { color: t.ink }]}>{p.name}</Text>
                <Text style={[styles.cardSummary, { color: t.inkMuted }]} numberOfLines={1}>
                  {p.summary}
                </Text>
              </View>
              {on && <Icon source="check-circle" size={20} color={accent} />}
            </View>
            <Miniature strip={p.strip} installed={installed} />
            <View style={styles.aids}>
              <Icon source="image-filter-center-focus" size={14} color={t.inkMuted} />
              <Text style={[styles.aidsText, { color: t.inkMuted }]} numberOfLines={1}>
                {presetAidsSummary(p, units)}
              </Text>
            </View>
            {missing.map((k) => (
              <View key={k} style={styles.needs}>
                <Text style={[styles.needsText, { color: t.inkVariant }]} numberOfLines={1}>
                  Needs {extensionBasics(k).label}
                </Text>
                <Button
                  compact
                  mode="text"
                  onPress={() => onGetExtension(k)}
                  accessibilityLabel={`Get ${extensionBasics(k).label}`}
                >
                  Get
                </Button>
              </View>
            ))}
          </Pressable>
        );
      })}
      <SectionTitle>Your strips</SectionTitle>
      {saved.map((s, i) => (
        <View key={`${s.name}-${i}`}>
          <View style={styles.savedRow}>
            <Pressable
              onPress={() => onApplySaved(i)}
              accessibilityRole="button"
              accessibilityLabel={`Your strip ${s.name}`}
              style={styles.savedMain}
            >
              <Icon source="bookmark-outline" size={22} color={t.inkVariant} />
              <View style={styles.cardText}>
                <Text style={[styles.cardName, { color: t.ink }]} numberOfLines={1}>
                  {s.name}
                </Text>
                <Text style={[styles.cardSummary, { color: t.inkMuted }]} numberOfLines={1}>
                  {s.rows.length} row{s.rows.length === 1 ? '' : 's'} · dock {s.dock}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => setMenu(menu === i ? null : i)}
              accessibilityRole="button"
              accessibilityLabel={`More for ${s.name}`}
              hitSlop={6}
              style={styles.more}
            >
              <Icon source="dots-vertical" size={22} color={t.inkMuted} />
            </Pressable>
          </View>
          {menu === i && (
            <View style={styles.menu}>
              <Button icon="pencil-outline" onPress={() => onRename(i)}>
                Rename
              </Button>
              <Button icon="content-duplicate" onPress={() => onDuplicate(i)}>
                Duplicate
              </Button>
              <Button
                icon="delete-outline"
                textColor={t.status.gpsLostInk}
                onPress={() => {
                  setMenu(null);
                  onDelete(i);
                }}
              >
                Delete
              </Button>
            </View>
          )}
        </View>
      ))}
      <Pressable
        onPress={onSave}
        accessibilityRole="button"
        accessibilityLabel="Save the current strip"
        style={styles.savedMain}
        testID="strip-save-current"
      >
        <Icon source="bookmark-plus-outline" size={22} color={t.inkVariant} />
        <View style={styles.cardText}>
          <Text style={[styles.cardName, { color: t.ink }]}>Save the current strip…</Text>
          <Text style={[styles.cardSummary, { color: t.inkMuted }]} numberOfLines={1}>
            {stripTitle(current, edited)}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

/** Save as / rename: a name, then Save or Cancel. */
export function SaveStripPage({
  title,
  initialName,
  summary,
  onSave,
  onCancel,
}: {
  title: string;
  initialName: string;
  summary: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  const [name, setName] = useState(initialName);
  const ok = name.trim() !== '';
  return (
    <View>
      <SubPanelHeader title={title} backLabel="Back to presets" onBack={onCancel} />
      <View style={[styles.field, { borderColor: t.outline }]}>
        <Text style={[styles.fieldLabel, { color: t.inkMuted }]}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={40}
          autoFocus
          style={[styles.input, { color: t.ink }]}
          accessibilityLabel="Strip name"
          returnKeyType="done"
          onSubmitEditing={() => {
            if (ok) onSave(name.trim());
          }}
          testID="strip-name-input"
        />
      </View>
      <Text style={[styles.cardSummary, styles.saveSummary, { color: t.inkMuted }]}>{summary}</Text>
      <View style={styles.actions}>
        <Button onPress={onCancel}>Cancel</Button>
        <Button
          mode="contained"
          icon="bookmark-plus-outline"
          buttonColor={accent}
          textColor={onAccent}
          disabled={!ok}
          onPress={() => onSave(name.trim())}
          accessibilityLabel="Save strip"
        >
          Save
        </Button>
      </View>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginVertical: 5,
    padding: 10,
    borderRadius: 14,
    borderWidth: 1.5,
    gap: 6,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardText: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 15, fontWeight: '700' },
  cardSummary: { fontSize: 12.5 },
  mini: { borderRadius: 8, paddingHorizontal: 8 },
  miniRow: { flexDirection: 'row', alignItems: 'center', height: 26, gap: 6 },
  miniCell: { minWidth: 0 },
  aids: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  aidsText: { fontSize: 12 },
  needs: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  needsText: { fontSize: 12.5, fontWeight: '600', flex: 1 },
  savedRow: { flexDirection: 'row', alignItems: 'center' },
  savedMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
  },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  menu: { flexDirection: 'row', flexWrap: 'wrap', paddingLeft: 52, paddingBottom: 6 },
  field: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  fieldLabel: { fontSize: 11.5 },
  input: { fontSize: 16, paddingVertical: 4 },
  saveSummary: { marginHorizontal: 16, marginTop: 6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, padding: 12 },
});
