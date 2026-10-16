import type { CursorKind, CursorSettings, CursorSize } from '@core/infoStrip/types';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line } from 'react-native-svg';
import { useScaledStyles } from '@ui/displayScale';

/** 2.5.1's dot at size S: its diameter and its ring's width, in dp (mockup #677: 7 dp, 1.5 dp ring). */
export const CURSOR_DOT = 7;
export const CURSOR_RING = 1.5;

/** The dot's diameter per size, dp (S is 2.5.1's). */
export const DOT_DP: Record<CursorSize, number> = { S: 7, M: 10, L: 13, XL: 17 };
/** The line icons' overall size per size, dp (mockup §7: M crosshair 30). */
export const ICON_DP: Record<CursorSize, number> = { S: 22, M: 30, L: 38, XL: 48 };

/** The halo: a paper outline under the strokes so the cursor reads on any map. */
const HALO_EXTRA = 2.4;
const PAD = 3;

/**
 * The centre cursor (#677, 2.6.0 map aid #673): the point the info strip's
 * centre coordinates read out, drawn over the map's centre. Dot (2.5.1),
 * Crosshair, Reticle, Ring or Cross, in four sizes and the cursor colours,
 * with an optional paper halo; set in the strip editor › Map aids.
 *
 * An OVERLAY, absolutely centred and touch-transparent, and STATIC: the
 * camera moves under it, so panning costs it nothing (no camera
 * subscription). It re-renders only when its settings or follow mode flip.
 *
 * Hidden when switched off, while the camera follows the user if set so
 * (the puck marks that spot), and while `suppressed` (the region selector
 * or map maker owns the screen).
 *
 * Over the pins and clusters, on purpose (2.5.2 QA decision): it is not a map
 * feature but the aim of the centre coordinates, and an aim that hides under
 * the thing it is on reads the wrong point. A view over the GL map cannot go
 * between GL layers anyway; it stays small, so a pin or disc under it stays
 * readable, and a tap goes through it (`pointerEvents="none"`).
 */
export const CenterCursor = memo(function CenterCursor({ suppressed }: { suppressed: boolean }) {
  const styles = useScaledStyles(stylesSheet);

  const cursor = useSettingsStore((s) => s.infoStrip.current.aids.cursor);
  const following = useMapStore((s) => s.followUser);
  if (!cursor.enabled || (following && cursor.hideWhileFollowing) || suppressed) return null;
  return (
    <View style={styles.center} pointerEvents="none" testID="map-center-cursor">
      <CursorGlyph cursor={cursor} />
    </View>
  );
});

/**
 * The cursor itself (also the editor's previews and the strip).
 *
 * `px`: draw at this overall size instead of the setting's (the strip draws
 * it at its glyph size beside a reading to the cursor); `testIDPrefix` keeps
 * that copy apart from the map's own in tests and E2E flows.
 */
export function CursorGlyph({
  cursor,
  px,
  testIDPrefix = 'map-center',
}: {
  cursor: CursorSettings;
  px?: number;
  testIDPrefix?: string;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  if (cursor.kind === 'dot') {
    const d = px === undefined ? DOT_DP[cursor.size] : Math.round(px * 0.6);
    const outer = d + 2 * CURSOR_RING;
    return (
      <View
        style={[
          styles.ring,
          {
            width: outer,
            height: outer,
            borderRadius: outer / 2,
            backgroundColor: cursor.halo ? t.map.cursorRing : 'transparent',
          },
        ]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View
          style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: cursor.color }}
          testID={`${testIDPrefix}-dot`}
        />
      </View>
    );
  }
  const kind = cursor.kind;
  const s = px ?? ICON_DP[cursor.size];
  const sw = s >= 30 ? 2 : 1.6;
  const strokes = (color: string, width: number, dotR: number) =>
    shape(kind, s, color, width, dotR);
  return (
    <Svg
      width={s + 2 * PAD}
      height={s + 2 * PAD}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={`${testIDPrefix}-${kind}`}
    >
      <G x={PAD} y={PAD}>
        {cursor.halo && strokes(t.map.cursorRing, sw + HALO_EXTRA, sw * 0.7 + HALO_EXTRA / 2)}
        {strokes(cursor.color, sw, sw * 0.7)}
      </G>
    </Svg>
  );
}

/** One icon's strokes in one colour and width; `dotR` is the centre dot's radius. */
function shape(
  kind: Exclude<CursorKind, 'dot'>,
  s: number,
  color: string,
  w: number,
  dotR: number,
): ReactElement {
  const c = s / 2;
  const line = (key: string, x1: number, y1: number, x2: number, y2: number) => (
    <Line
      key={key}
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={color}
      strokeWidth={w}
      strokeLinecap="round"
    />
  );
  const dot = <Circle key="dot" cx={c} cy={c} r={dotR} fill={color} />;
  switch (kind) {
    case 'cross': {
      const g = s * 0.18;
      return (
        <G>
          {line('n', c, 0, c, c - g)}
          {line('s', c, c + g, c, s)}
          {line('w', 0, c, c - g, c)}
          {line('e', c + g, c, s, c)}
          {dot}
        </G>
      );
    }
    case 'reticle': {
      const r = s * 0.32;
      return (
        <G>
          <Circle cx={c} cy={c} r={r} stroke={color} strokeWidth={w} fill="none" />
          {line('n', c, 0, c, c - r)}
          {line('s', c, c + r, c, s)}
          {line('w', 0, c, c - r, c)}
          {line('e', c + r, c, s, c)}
          {dot}
        </G>
      );
    }
    case 'ring':
      return (
        <G>
          <Circle cx={c} cy={c} r={c - w} stroke={color} strokeWidth={w} fill="none" />
          {dot}
        </G>
      );
    case 'x': {
      const a = s * 0.18;
      const b = s * 0.82;
      return (
        <G>
          {line('a', a, a, b, b)}
          {line('b', b, a, a, b)}
        </G>
      );
    }
  }
}

const stylesSheet = StyleSheet.create({
  center: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: { alignItems: 'center', justifyContent: 'center' },
});
