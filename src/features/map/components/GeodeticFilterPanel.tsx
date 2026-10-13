import { GEODETIC_CATALOG } from '@core/geodetic/catalog';
import { formatCount } from '@core/geodetic/coverage';
import {
  activeFilterCount,
  DEFAULT_GEODETIC_FILTER,
  FILTER_STATUSES,
  FILTER_TYPES,
  PRECISION_FILTERS,
  VISITED_SINCE_CHOICES,
  type DatumFilter,
  type GeodeticFilter,
  type PrecisionFilter,
} from '@core/geodetic/filter';
import type { MarkStatus, MarkType } from '@core/geodetic/record';
import { useGeodeticStore } from '@state/geodeticStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { refreshGeodeticCoverage } from '@data/geodeticCoverage';
import { geodeticImage } from '../geodeticImages';
import { SectionTitle, Segmented, SwitchRow, useSheetAccent } from './mapSheet';

const TYPE_LABEL: Record<MarkType, string> = {
  '3d': '3D',
  h: 'Horizontal',
  v: 'Vertical',
  gnss: 'GNSS',
  u: 'Other',
};
const STATUS_LABEL: Record<MarkStatus, string> = {
  ok: 'Good',
  damaged: 'To verify',
  unknown: 'Unknown',
};
const DATUM_LEVELS: { value: DatumFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'modern', label: 'Modern' },
  { value: 'legacy', label: 'Legacy' },
];
const PRECISION_LABEL: Record<PrecisionFilter, string> = {
  any: 'Any',
  '10': '±10 m',
  '2': '±2 m',
  '1': '< 1 m',
};
const PRECISION_LEVELS = PRECISION_FILTERS.map((p) => ({ value: p, label: PRECISION_LABEL[p] }));
const VISIT_LEVELS = VISITED_SINCE_CHOICES.map((y) => ({
  value: y,
  label: y === 0 ? 'Any' : `${y}+`,
}));
/** Vertical-datum chips shown at most (most marks first). */
const MAX_VDATUM_CHIPS = 14;

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** A selectable chip in the sheet's palette (accent when on). */
function FilterChip({
  label,
  count,
  selected,
  onPress,
  icon,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onPress: () => void;
  icon?: ReturnType<typeof geodeticImage>;
}) {
  const tokens = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: accent, borderColor: accent }
          : { borderColor: tokens.outline, backgroundColor: 'transparent' },
      ]}
    >
      {icon !== undefined && (
        <View style={styles.chipIconWell}>
          <Image source={icon} style={styles.chipIcon} />
        </View>
      )}
      <Text style={[styles.chipLabel, { color: selected ? onAccent : tokens.inkVariant }]}>
        {label}
        {count !== undefined && (
          <Text style={{ color: selected ? onAccent : tokens.inkMuted }}>
            {`  ${formatCount(count)}`}
          </Text>
        )}
      </Text>
    </Pressable>
  );
}

/** "Reset": every geodetic filter back to its default; quiet while none is on. */
export function GeodeticFilterReset() {
  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const active = useSettingsStore((s) => activeFilterCount(s.geodeticFilter));
  const setSetting = useSettingsStore((s) => s.set);
  return (
    <Pressable
      onPress={() => setSetting('geodeticFilter', { ...DEFAULT_GEODETIC_FILTER })}
      disabled={active === 0}
      accessibilityRole="button"
      accessibilityLabel="Reset geodetic filters"
      accessibilityState={{ disabled: active === 0 }}
      hitSlop={8}
    >
      <Text style={[styles.reset, { color: active === 0 ? tokens.inkMuted : accent }]}>Reset</Text>
    </Pressable>
  );
}

/**
 * Filter geodetic points by their attributes (`@core/geodetic/filter`): the
 * body of the Geodetic points sub-panel (`GeodeticSubPanel`), in the sheet's
 * idiom (section titles, segmented pickers, switch rows). Every change
 * applies live and is persisted.
 */
export function GeodeticFilters() {
  const tokens = useSchemeTokens();
  const dark = useTheme().dark;
  const filter = useSettingsStore((s) => s.geodeticFilter);
  const setSetting = useSettingsStore((s) => s.set);
  const coverage = useGeodeticStore((s) => s.coverage);
  const set = (patch: Partial<GeodeticFilter>) =>
    setSetting('geodeticFilter', { ...filter, ...patch });

  useEffect(() => {
    if (coverage === null) void refreshGeodeticCoverage();
  }, [coverage]);

  const sources = GEODETIC_CATALOG.sources
    .map((s, i) => ({ s, i, n: coverage?.counts.get(i) }))
    .filter((x) => coverage === null || x.n !== undefined)
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
  const vdatums = [...(coverage?.vdatums ?? new Map<number, number>())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_VDATUM_CHIPS)
    .flatMap(([i, n]) => {
      const v = GEODETIC_CATALOG.vdatums[i];
      return v ? [{ i, n, name: v.name }] : [];
    });

  return (
    <>
      <SectionTitle>Type</SectionTitle>
      <View style={styles.chips}>
        {FILTER_TYPES.map((k) => (
          <FilterChip
            key={k}
            label={TYPE_LABEL[k]}
            icon={geodeticImage(dark ? 'dark' : 'light', k)}
            selected={filter.types.includes(k)}
            onPress={() => set({ types: toggle(filter.types, k) })}
          />
        ))}
        {/* Tidal benchmarks (@core/tides/tidalBenchmark): their own symbol. */}
        <FilterChip
          label="Tidal"
          icon={geodeticImage(dark ? 'dark' : 'light', 'tbm')}
          selected={filter.tidal}
          onPress={() => set({ tidal: !filter.tidal })}
        />
      </View>

      <SectionTitle>Datum</SectionTitle>
      <View style={styles.pad}>
        <Segmented
          levels={DATUM_LEVELS}
          selected={filter.datum}
          onSelect={(datum) => set({ datum })}
        />
      </View>

      <SectionTitle>Condition</SectionTitle>
      <View style={styles.chips}>
        {FILTER_STATUSES.map((st) => (
          <FilterChip
            key={st}
            label={STATUS_LABEL[st]}
            selected={filter.status.includes(st)}
            onPress={() => set({ status: toggle(filter.status, st) })}
          />
        ))}
      </View>

      <SectionTitle>Position precision</SectionTitle>
      <View style={styles.pad}>
        <Segmented
          levels={PRECISION_LEVELS}
          selected={filter.precision}
          onSelect={(precision) => set({ precision })}
        />
      </View>

      <SectionTitle>Details</SectionTitle>
      <SwitchRow
        icon="arrow-expand-vertical"
        label="Has heights"
        hint="At least one published height"
        value={filter.hasHeights}
        onToggle={() => set({ hasHeights: !filter.hasHeights })}
      />
      <SwitchRow
        icon="file-document-outline"
        label="Has datasheet details"
        hint="The agency's published coordinates"
        value={filter.hasDetails}
        onToggle={() => set({ hasDetails: !filter.hasDetails })}
      />

      <SectionTitle>Last visited</SectionTitle>
      <View style={styles.pad}>
        <Segmented
          levels={VISIT_LEVELS}
          selected={filter.visitedSince}
          onSelect={(visitedSince) => set({ visitedSince })}
        />
      </View>

      {vdatums.length > 0 && (
        <>
          <SectionTitle>Vertical datum</SectionTitle>
          <View style={styles.chips}>
            {vdatums.map(({ i, n, name }) => (
              <FilterChip
                key={i}
                label={name}
                count={n}
                selected={filter.vdatums.includes(i)}
                onPress={() => set({ vdatums: toggle(filter.vdatums, i) })}
              />
            ))}
          </View>
          <Text style={[styles.note, { color: tokens.inkMuted }]}>
            None selected: any. Selected: marks with a height on any of them.
          </Text>
        </>
      )}

      <SectionTitle>Sources</SectionTitle>
      <View style={styles.chips}>
        {sources.map(({ s, i, n }) => (
          <FilterChip
            key={s.key}
            label={s.name}
            {...(n !== undefined ? { count: n } : {})}
            selected={!filter.hiddenSources.includes(i)}
            onPress={() => set({ hiddenSources: toggle(filter.hiddenSources, i) })}
          />
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  reset: { fontSize: 15, fontWeight: '700' },
  pad: { paddingHorizontal: 16, paddingBottom: 4 },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    minHeight: 32,
    gap: 6,
  },
  chipIconWell: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipIcon: { width: 16, height: 16 },
  chipLabel: { fontSize: 14, fontWeight: '600' },
  note: { fontSize: 12, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 6 },
});
