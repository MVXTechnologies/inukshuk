/**
 * A drawing tool's sub-panel (#756, mockup 756 point 4; was the one "Style"
 * popover of #683). Each tool's own options live in its panel, never as
 * greyed-out rows elsewhere (the sub-menu rule):
 *
 * - Freehand: colour, width, solid or dashed;
 * - Arrow: colour, width, the head and its size;
 * - Shape: the shape picker (Circle, Rectangle), then colour, width, dash;
 * - Time: how long the next shapes stay (a 4 × 2 grid at full size, not
 *   seven options squeezed into one row).
 *
 * Colour and width apply to every tool: each panel shows them, and they set
 * one shared, remembered style. A plain themed View anchored over the tool
 * bar, never a Portal (paper-portal-touch-swallow).
 */
import type { ShapeKind } from '@core/teamdraw/record';
import { FADE_CHOICES_MS, type DrawPrefs } from '@core/teamdraw/style';
import { MEMBER_COLORS } from '@core/teamui/colors';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { Icon, IconButton, Text, useTheme } from 'react-native-paper';

import { COLOUR_NAMES } from './drawShared';

const WIDTH_NAMES = { 1: 'Thin', 2: 'Medium', 3: 'Thick' } as const;
const HEAD_SIZE_LETTERS = { 1: 'S', 2: 'M', 3: 'L' } as const;
const HEAD_SIZE_NAMES = { 1: 'Small', 2: 'Medium', 3: 'Large' } as const;

/** "10 s", "5 min", "4 h", "Never". */
export function fadeLabel(ms: number | null): string {
  if (ms === null) return 'Never';
  if (ms < 60_000) return `${ms / 1000} s`;
  if (ms < 3_600_000) return `${ms / 60_000} min`;
  return `${ms / 3_600_000} h`;
}

/** The Time button's badge: "30s", "5m", "4h", "∞". */
export function fadeBadge(ms: number | null): string {
  if (ms === null) return '∞';
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000}m`;
  return `${ms / 3_600_000}h`;
}

/** The panels: one per tool button that has options. */
export type ToolPanel = 'free' | 'arrow' | 'shape' | 'time';
/** The shapes the Shape button picks between. */
export const SHAPE_CHOICES: readonly { k: ShapeKind; icon: string; label: string }[] = [
  { k: 'circle', icon: 'circle-outline', label: 'Circle' },
  { k: 'rect', icon: 'square-outline', label: 'Rectangle' },
];
const PANEL_TITLE: Record<ToolPanel, string> = {
  free: 'Freehand',
  arrow: 'Arrow',
  shape: 'Shape',
  time: 'Fades after',
};

function Seg<T>({
  items,
  value,
  onPick,
  label,
  testID,
  tight,
}: {
  items: readonly { v: T; node: ReactNode; a11y: string }[];
  value: T;
  onPick: (v: T) => void;
  label: string;
  testID: string;
  tight?: boolean;
}) {
  const t = useSchemeTokens();
  const { colors } = useTheme();
  return (
    <View
      style={[styles.seg, { backgroundColor: t.surfaceVariant }]}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {items.map((it, i) => {
        const on = it.v === value;
        return (
          <Pressable
            key={i}
            onPress={() => onPick(it.v)}
            style={[
              styles.segItem,
              tight && styles.segTight,
              on && { backgroundColor: colors.primary },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={it.a11y}
            testID={`${testID}-${i}`}
          >
            {typeof it.node === 'string' ? (
              <Text
                variant="labelMedium"
                style={{
                  color: on ? colors.onPrimary : t.inkVariant,
                  fontWeight: on ? '800' : '700',
                }}
                numberOfLines={1}
                // "5 min" and "30 min" ran together in the 7-way fade row (2.5.2 QA).
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {it.node}
              </Text>
            ) : (
              <View style={{ opacity: on ? 1 : 0.8 }}>{it.node}</View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function Section({
  children,
  right,
  rightDot,
}: {
  children: string;
  right?: string;
  /** A dot in this colour before `right` ("● your colour"). */
  rightDot?: string;
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.sec}>
      <Text style={[styles.secText, { color: t.inkMuted }]}>{children.toUpperCase()}</Text>
      {right ? (
        <Text style={[styles.secRight, { color: t.inkMuted }]} testID="team-draw-own-colour">
          {rightDot !== undefined ? <Text style={{ color: rightDot }}>{'● '}</Text> : null}
          {right}
        </Text>
      ) : null}
    </View>
  );
}

export function DrawToolPanel({
  kind,
  prefs,
  own,
  shape,
  onShape,
  onChange,
  onClose,
  bottom,
}: {
  kind: ToolPanel;
  prefs: DrawPrefs;
  /** My member colour's index ("yours"). */
  own: number;
  /** The Shape button's current shape (the picker's selection). */
  shape: ShapeKind;
  onShape: (k: ShapeKind) => void;
  onChange: (p: DrawPrefs) => void;
  onClose: () => void;
  bottom: number;
}) {
  const t = useSchemeTokens();
  const { colors } = useTheme();
  const set = (patch: Partial<DrawPrefs>) => onChange({ ...prefs, ...patch });
  const ink = (on: boolean) => (on ? colors.onPrimary : t.inkVariant);
  const widthIcon = (w: 1 | 2 | 3) => {
    const on = prefs.width === w;
    const sw = { 1: 3, 2: 5, 3: 8 }[w];
    return (
      <Svg width={22} height={12}>
        <Line
          x1={3}
          y1={6}
          x2={19}
          y2={6}
          stroke={ink(on)}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </Svg>
    );
  };
  const headIcon = (k: DrawPrefs['head']) => {
    const c = ink(prefs.head === k);
    if (k === 'open')
      return (
        <Svg width={22} height={14}>
          <Path d="M2 7 H19 M13 2 L19 7 L13 12" stroke={c} strokeWidth={2.5} fill="none" />
        </Svg>
      );
    if (k === 'both')
      return (
        <Svg width={24} height={14}>
          <Path d="M8 7 H16" stroke={c} strokeWidth={2.5} />
          <Path d="M23 7 L15 2 L15 12Z M1 7 L9 2 L9 12Z" fill={c} />
        </Svg>
      );
    return (
      <Svg width={22} height={14}>
        <Path d="M2 7 H12" stroke={c} strokeWidth={2.5} />
        <Path d="M20 7 L11 2 L11 12Z" fill={c} />
      </Svg>
    );
  };
  const colour = (
    <>
      <Section right="your colour" rightDot={MEMBER_COLORS[own]}>
        Colour
      </Section>
      <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Colour">
        {MEMBER_COLORS.map((c, i) => {
          const on = prefs.colour === i;
          return (
            <Pressable
              key={c}
              onPress={() => set({ colour: i })}
              hitSlop={4}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={i === own ? `${COLOUR_NAMES[i]}, your colour` : COLOUR_NAMES[i]}
              testID={`team-draw-colour-${i}`}
              style={[styles.swatchRing, { borderColor: on ? t.ink : 'transparent' }]}
            >
              <View style={[styles.swatch, { backgroundColor: c }]}>
                {on && <Icon source="check" size={20} color={palette.white} />}
              </View>
            </Pressable>
          );
        })}
      </View>
    </>
  );
  const width = (
    <>
      <Section>Width</Section>
      <Seg
        label="Width"
        testID="team-draw-width"
        value={prefs.width}
        onPick={(w) => set({ width: w })}
        items={([1, 2, 3] as const).map((w) => ({
          v: w,
          node: (
            <View style={styles.widthItem}>
              {widthIcon(w)}
              <Text
                variant="labelMedium"
                style={{ color: ink(prefs.width === w), fontWeight: '700' }}
                numberOfLines={1}
              >
                {WIDTH_NAMES[w]}
              </Text>
            </View>
          ),
          a11y: WIDTH_NAMES[w],
        }))}
      />
    </>
  );
  const line = (
    <>
      <Section>Line</Section>
      <Seg
        label="Line"
        testID="team-draw-dash"
        value={prefs.dashed}
        onPick={(dashed) => set({ dashed })}
        items={[
          { v: false, node: 'Solid', a11y: 'Solid' },
          { v: true, node: 'Dashed', a11y: 'Dashed' },
        ]}
      />
    </>
  );
  return (
    <View style={[styles.dock, { bottom }]} pointerEvents="box-none">
      <View
        style={[
          styles.pop,
          {
            backgroundColor: t.surface,
            borderColor: t.outlineVariant,
            shadowColor: palette.shadow,
          },
        ]}
        testID="team-draw-panel"
      >
        <View style={styles.head}>
          <Text
            variant="titleSmall"
            style={{ color: t.ink, fontWeight: '800' }}
            testID={`team-draw-panel-${kind}`}
          >
            {PANEL_TITLE[kind]}
          </Text>
          <IconButton
            icon="close"
            size={20}
            onPress={onClose}
            accessibilityLabel={`Close ${PANEL_TITLE[kind]}`}
            testID="team-draw-panel-close"
          />
        </View>
        {kind === 'shape' && (
          <View style={styles.shapes} accessibilityRole="radiogroup" accessibilityLabel="Shape">
            {SHAPE_CHOICES.map(({ k, icon, label }) => {
              const on = k === shape;
              return (
                <Pressable
                  key={k}
                  onPress={() => onShape(k)}
                  style={[
                    styles.shape,
                    { backgroundColor: on ? colors.primary : t.surfaceVariant },
                  ]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={label}
                  testID={`team-draw-shape-${k}`}
                >
                  <Icon source={icon} size={26} color={ink(on)} />
                  <Text
                    variant="labelLarge"
                    style={{ color: ink(on), fontWeight: '800' }}
                    numberOfLines={1}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {kind === 'time' ? (
          <>
            <View
              style={styles.grid}
              accessibilityRole="radiogroup"
              accessibilityLabel="Fades after"
            >
              {FADE_CHOICES_MS.map((ms, i) => {
                const on = prefs.fadeMs === ms;
                return (
                  <Pressable
                    key={i}
                    onPress={() => set({ fadeMs: ms })}
                    style={[
                      styles.cell,
                      { backgroundColor: on ? colors.primary : t.surfaceVariant },
                    ]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={fadeLabel(ms)}
                    testID={`team-draw-fade-${i}`}
                  >
                    <Text
                      variant="labelLarge"
                      style={{ color: ink(on), fontWeight: on ? '800' : '700' }}
                      numberOfLines={1}
                    >
                      {fadeLabel(ms)}
                    </Text>
                  </Pressable>
                );
              })}
              {/* Keeps the last row in the same four columns. */}
              {Array.from({ length: (4 - (FADE_CHOICES_MS.length % 4)) % 4 }, (_, i) => (
                <View key={`pad${i}`} style={styles.cell} />
              ))}
            </View>
            <Text variant="bodySmall" style={[styles.foot, { color: t.inkMuted }]}>
              Applies to your next shapes.
            </Text>
          </>
        ) : (
          <>
            {colour}
            {width}
            {kind === 'arrow' ? (
              <>
                <Section>Arrow head</Section>
                <Seg
                  label="Arrow head"
                  testID="team-draw-head"
                  value={prefs.head}
                  onPick={(head) => set({ head })}
                  items={(['fill', 'open', 'both'] as const).map((h) => ({
                    v: h,
                    node: headIcon(h),
                    a11y: { fill: 'Filled', open: 'Open', both: 'Both ends' }[h],
                  }))}
                />
                <Section>Head size</Section>
                <Seg
                  label="Head size"
                  testID="team-draw-headsize"
                  value={prefs.headSize}
                  onPick={(headSize) => set({ headSize })}
                  items={([1, 2, 3] as const).map((sz) => ({
                    v: sz,
                    node: HEAD_SIZE_LETTERS[sz],
                    a11y: HEAD_SIZE_NAMES[sz],
                  }))}
                />
              </>
            ) : (
              line
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Centred, the same margin either side, at most 360 dp wide.
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 10,
  },
  pop: {
    width: '100%',
    maxWidth: 360,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 2,
    paddingBottom: 14,
    zIndex: 10,
    elevation: 10,
    shadowOpacity: 0.32,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 10 },
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sec: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, marginBottom: 5 },
  secText: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 1.1 },
  secRight: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  swatches: { flexDirection: 'row', justifyContent: 'space-between' },
  swatchRing: { borderWidth: 2, borderRadius: 22, padding: 2 },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  widthItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shapes: { flexDirection: 'row', gap: 8, marginTop: 2 },
  shape: {
    flex: 1,
    minHeight: 64,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 4,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  // Four a row (the 4 × 2 grid of mockup 756): a quarter less the gaps.
  cell: {
    flexBasis: '22%',
    flexGrow: 1,
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  seg: { flex: 1, flexDirection: 'row', gap: 3, padding: 3, borderRadius: 11 },
  segItem: {
    flex: 1,
    minHeight: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  segTight: { paddingHorizontal: 3 },
  foot: { marginTop: 10 },
});
