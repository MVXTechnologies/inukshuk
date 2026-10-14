import { CURSOR_COLORS } from '@core/infoStrip/presets';
import type { CursorKind, CursorSettings as Cursor, CursorSize } from '@core/infoStrip/types';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { CursorGlyph } from '../../components/CenterCursor';
import { SectionTitle, Segmented, SubPanelHeader, SwitchRow } from '../../components/mapSheet';
import { waypointInk } from '@core/library/waypointStyle';

export const CURSOR_KINDS: readonly { kind: CursorKind; label: string }[] = [
  { kind: 'dot', label: 'Dot' },
  { kind: 'cross', label: 'Crosshair' },
  { kind: 'reticle', label: 'Reticle' },
  { kind: 'ring', label: 'Ring' },
  { kind: 'x', label: 'Cross' },
];
const SIZES: readonly { value: CursorSize; label: string }[] = [
  { value: 'S', label: 'S' },
  { value: 'M', label: 'M' },
  { value: 'L', label: 'L' },
  { value: 'XL', label: 'XL' },
];

/** The preview's stand-in for the map: mid-tone, so both the paper halo and a dark cursor read. */
export const PREVIEW_MAP = palette.granite;

/** "Dot · S · Stone", "Crosshair · M · Red", or "Off". */
export function cursorSummary(c: Cursor): string {
  if (!c.enabled) return 'Off';
  const kind = CURSOR_KINDS.find((k) => k.kind === c.kind)!.label;
  const colour = CURSOR_COLORS.find((k) => k.hex === c.color)?.name ?? c.color;
  return `${kind} · ${c.size} · ${colour}`;
}

/**
 * Map aids › Centre cursor (mockup §7 `cfgCursor`): on/off, the icon (Dot as
 * in 2.5.1, Crosshair, Reticle, Ring, Cross), four sizes, the cursor
 * colours, the paper halo, and whether it hides while the map follows you.
 * Every option can be set while it is off.
 */
export function CursorSettings({
  cursor,
  onChange,
  onBack,
}: {
  cursor: Cursor;
  onChange: (c: Cursor) => void;
  onBack: () => void;
}) {
  const t = useSchemeTokens();
  const set = (patch: Partial<Cursor>) => onChange({ ...cursor, ...patch });
  return (
    <View>
      <SubPanelHeader title="Centre cursor" backLabel="Back to info strip" onBack={onBack} />
      {/* A mid-grey map swatch, not the sheet's paper: the paper halo vanished
        on it in the light theme (QA 2.6.0). Same swatch in both themes, as
        the map under the cursor does not follow the sheet's theme. */}
      <View style={[styles.preview, { backgroundColor: PREVIEW_MAP }]} testID="cursor-preview">
        <CursorGlyph cursor={{ ...cursor, enabled: true }} />
      </View>
      <SwitchRow
        icon="image-filter-center-focus"
        label="Show centre cursor"
        hint={cursor.enabled ? cursorSummary(cursor) : 'Hidden on the map'}
        value={cursor.enabled}
        onToggle={() => set({ enabled: !cursor.enabled })}
      />
      <SectionTitle>Icon</SectionTitle>
      <View style={styles.tiles} accessibilityRole="radiogroup" accessibilityLabel="Cursor icon">
        {CURSOR_KINDS.map((k) => {
          const on = k.kind === cursor.kind;
          return (
            <Pressable
              key={k.kind}
              onPress={() => set({ kind: k.kind })}
              accessibilityRole="radio"
              accessibilityLabel={k.label}
              accessibilityState={{ checked: on, selected: on }}
              style={[
                styles.tile,
                { backgroundColor: t.surfaceVariant, borderColor: on ? t.ink : 'transparent' },
              ]}
            >
              <View style={styles.tileGlyph}>
                <CursorGlyph
                  cursor={{ ...cursor, kind: k.kind, size: k.kind === 'dot' ? 'M' : 'S' }}
                />
              </View>
              <Text style={[styles.tileLabel, { color: t.inkVariant }]} numberOfLines={1}>
                {k.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <SectionTitle>Size</SectionTitle>
      <View style={styles.pad}>
        <Segmented levels={SIZES} selected={cursor.size} onSelect={(size) => set({ size })} />
      </View>
      <SectionTitle>Colour</SectionTitle>
      <View
        style={styles.swatches}
        accessibilityRole="radiogroup"
        accessibilityLabel="Cursor colour"
      >
        {CURSOR_COLORS.map((c) => {
          const on = c.hex === cursor.color;
          return (
            <Pressable
              key={c.hex}
              onPress={() => set({ color: c.hex })}
              accessibilityRole="radio"
              accessibilityLabel={c.name}
              accessibilityState={{ checked: on, selected: on }}
              hitSlop={5}
              style={[
                styles.swatch,
                { backgroundColor: c.hex },
                c.hex === palette.surface && { borderWidth: 1, borderColor: palette.granite },
                on && { borderWidth: 2.5, borderColor: t.ink },
              ]}
            >
              {on && <Icon source="check" size={16} color={waypointInk(c.hex)} />}
            </Pressable>
          );
        })}
      </View>
      <SwitchRow
        icon="circle-double"
        label="Halo"
        hint="A paper outline so it reads on any map"
        value={cursor.halo}
        onToggle={() => set({ halo: !cursor.halo })}
      />
      <SwitchRow
        icon="crosshairs-gps"
        label="Hide while the map follows you"
        hint="The puck marks the spot"
        value={cursor.hideWhileFollowing}
        onToggle={() => set({ hideWhileFollowing: !cursor.hideWhileFollowing })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  preview: {
    height: 72,
    marginHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tiles: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
  tile: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 2,
  },
  tileGlyph: { height: 32, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontSize: 11.5 },
  pad: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6 },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
