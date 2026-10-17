import type { AnyExtensionKey } from '@core/extensions/keys';
import { canAddRow } from '@core/infoStrip/edit';
import { fitRow, ROW_SPACES } from '@core/infoStrip/layout';
import { ref } from '@core/infoStrip/presets';
import { FIELD_GROUPS, pickableFields, type FieldId } from '@core/infoStrip/registry';
import type { ComputeContext, DepsSnapshot, FieldGroup, FieldRef } from '@core/infoStrip/types';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Icon, IconButton, Text } from '@ui/paper';

import { SectionTitle, SheetNote, useSheetAccent } from '../../components/mapSheet';
import { GROUP_ICON, GROUP_LABEL, glyphIcon } from '../glyphs';
import { StripField } from '../StripField';
import { previewValue } from './preview';
import { useScaledStyles } from '@ui/displayScale';

type Rows = readonly (readonly FieldRef[])[];

/**
 * The field picker (mockup §3 `picker`): grouped and searchable, each field
 * with a live preview in strip style, and ONLY the fields that fit the free
 * space of the row being added to — nothing greyed out (the owner's sub-menu
 * rule). A footnote says where a wider field would fit.
 */
export function FieldPicker({
  rows,
  row,
  installed,
  data,
  ctx,
  onPick,
  onClose,
}: {
  rows: Rows;
  /** The row being added to; `rows.length` is a new row. */
  row: number;
  installed: ReadonlySet<AnyExtensionKey>;
  data: DepsSnapshot;
  ctx: ComputeContext;
  onPick: (f: FieldRef) => void;
  onClose: () => void;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<FieldGroup | null>(null);
  const target = rows[row];
  const free = target === undefined ? ROW_SPACES : fitRow(target).free;
  const fields = pickableFields(free, installed, query).filter(
    (d) => group === null || d.group === group,
  );
  const wider = pickableFields(ROW_SPACES, installed, query).filter(
    (d) => d.spaces > free && (group === null || d.group === group),
  );
  const title = target === undefined ? 'Add a row' : `Add to row ${row + 1}`;

  return (
    <View>
      <View style={styles.head}>
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          {title}
        </Text>
        <IconButton
          icon="close"
          size={20}
          iconColor={t.inkMuted}
          onPress={onClose}
          accessibilityLabel="Close the field picker"
        />
      </View>
      <View style={[styles.search, { backgroundColor: t.surfaceVariant }]}>
        <Icon source="magnify" size={18} color={t.inkMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search fields"
          placeholderTextColor={t.inkMuted}
          style={[styles.searchInput, { color: t.ink }]}
          accessibilityLabel="Search fields"
          autoCorrect={false}
          returnKeyType="search"
          testID="strip-field-search"
        />
      </View>
      <View style={styles.chips} accessibilityRole="tablist">
        {([null, ...FIELD_GROUPS] as const).map((g) => {
          const on = g === group;
          return (
            <Pressable
              key={g ?? 'all'}
              onPress={() => setGroup(g)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={g === null ? 'All fields' : `${GROUP_LABEL[g]} fields`}
              style={[styles.chip, { backgroundColor: on ? accent : t.surfaceVariant }]}
            >
              <Text style={[styles.chipText, { color: on ? onAccent : t.inkVariant }]}>
                {g === null ? 'All' : GROUP_LABEL[g]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {FIELD_GROUPS.map((g) => {
        const list = fields.filter((d) => d.group === g);
        if (list.length === 0) return null;
        return (
          <View key={g}>
            <SectionTitle>{GROUP_LABEL[g]}</SectionTitle>
            {list.map((d) => {
              const f = ref(d.id as FieldId);
              const pv = previewValue(f, data, ctx)!;
              return (
                <Pressable
                  key={d.id}
                  onPress={() => onPick(f)}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${d.label}`}
                  accessibilityHint={d.summary}
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                  testID={`strip-pick-${d.id}`}
                >
                  <Icon
                    source={d.sample.glyph ? glyphIcon(d.sample.glyph) : GROUP_ICON[d.group]}
                    size={22}
                    color={t.inkVariant}
                  />
                  <View style={styles.rowText}>
                    <Text style={[styles.label, { color: t.ink }]} numberOfLines={1}>
                      {d.label}
                    </Text>
                    {/* Two lines: beside a wide preview one line cut the summary short
                      ("Waypoint, trail target or nav tar…", QA 2.6.0). */}
                    <Text style={[styles.hint, { color: t.inkMuted }]} numberOfLines={2}>
                      {d.summary}
                    </Text>
                  </View>
                  <View style={[styles.preview, { backgroundColor: t.surfaceVariant }]}>
                    <StripField value={pv.value} shrink muted={!pv.live} />
                  </View>
                </Pressable>
              );
            })}
          </View>
        );
      })}
      {fields.length === 0 && (
        <Text style={[styles.empty, { color: t.inkMuted }]}>No field matches “{query}”.</Text>
      )}
      {wider.length > 0 && (
        <SheetNote icon="information-outline">
          {`Row ${row + 1} has ${free} space${free === 1 ? '' : 's'} left. ` +
            (canAddRow(rows)
              ? `${wider.map((d) => d.label).join(', ')} (${wider[0]!.spaces} spaces) fit in a new row.`
              : `${wider.map((d) => d.label).join(', ')} need ${wider[0]!.spaces} spaces.`)}
        </SheetNote>
      )}
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16 },
  title: { flex: 1, fontSize: 17, fontWeight: '800' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    borderRadius: 12,
    height: 44,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingTop: 10 },
  chip: { borderRadius: 16, paddingHorizontal: 12, height: 32, justifyContent: 'center' },
  chipText: { fontSize: 13, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  rowText: { flex: 1, minWidth: 0 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12.5 },
  preview: {
    maxWidth: 150,
    borderRadius: 8,
    paddingHorizontal: 8,
    height: 30,
    justifyContent: 'center',
  },
  empty: { paddingHorizontal: 16, paddingVertical: 12, fontSize: 14 },
});
