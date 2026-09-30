import { useId } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from 'react-native-paper';
import Svg, { ClipPath, Defs, G, Path } from 'react-native-svg';

import { useDisplayCondition } from '../displayCondition';
import { palette } from '../tokens';
import { useSchemeTokens } from '../useSchemeTokens';
import {
  FACET_STROKE_WIDTH,
  FIGURE_H,
  FIGURE_W,
  nightTone,
  STONES,
  type StoneShape,
} from './inukshukStones';

/**
 * - `day`: the approved charcoal granite with its lighter facets (the app icon);
 * - `night`: the same stones lifted to the night tone, for dark surfaces;
 * - `mono`: a flat single-colour silhouette in `color`, for tinted icons
 *   (waypoint pins, menu rows, selected tiles) and the high-contrast modes;
 * - `auto` (default): day or night from the theme, mono in `ink` under
 *   Sunlight and Night red.
 */
export type InukshukTone = 'auto' | 'day' | 'night' | 'mono';

export interface InukshukGlyphProps {
  /**
   * Height of the figure in dp (its width follows, ~0.9×). With
   * `frame="square"` it is the side of the square box instead, the figure
   * centred inside like an icon-font glyph. Default 24.
   */
  size?: number;
  tone?: InukshukTone;
  /** The silhouette colour for `mono` (and `auto` in Sunlight / Night red). */
  color?: string;
  /** `figure` (default): the box hugs the figure. `square`: an icon-sized square. */
  frame?: 'figure' | 'square';
  /** When given, the glyph is announced as an image; otherwise it is decorative. */
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** How much of a square frame the figure's height fills (as the old 24-unit icon). */
const SQUARE_FILL = 20 / 24;

/**
 * The Inukshuk: Marc's five faceted granite stones — head, arm slab, body
 * stone, two legs — exactly as in the app icon (`assets/brand`). The one
 * figure every screen draws; `InukshukLoader` animates the same stones.
 */
export function InukshukGlyph(props: InukshukGlyphProps) {
  if ((props.tone ?? 'auto') === 'auto') return <AutoGlyph {...props} />;
  return <GlyphFigure {...props} />;
}

function AutoGlyph(props: InukshukGlyphProps) {
  const condition = useDisplayCondition();
  const t = useSchemeTokens();
  const { dark } = useTheme();
  if (condition !== 'normal') return <GlyphFigure {...props} tone="mono" color={t.ink} />;
  return <GlyphFigure {...props} tone={dark ? 'night' : 'day'} />;
}

function GlyphFigure({
  size = 24,
  tone = 'day',
  color = palette.ink,
  frame = 'figure',
  accessibilityLabel,
  testID,
  style,
}: InukshukGlyphProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const height = frame === 'square' ? size * SQUARE_FILL : size;
  const width = (height * FIGURE_W) / FIGURE_H;
  const mono = tone === 'mono';
  const inset = stoneInset(height, mono);
  const tint = tone === 'night' ? nightTone : identity;
  const figure = (
    <Svg width={width} height={height} viewBox={`0 0 ${FIGURE_W} ${FIGURE_H}`}>
      {STONES.map((s) => (
        <G key={s.id} transform={stoneTransform(s, inset)}>
          {mono ? (
            <Path d={s.outline} fill={color} />
          ) : (
            <StoneArt shape={s} tint={tint} clipId={`inukg-${uid}-${s.id}`} />
          )}
        </G>
      ))}
    </Svg>
  );
  const a11y = accessibilityLabel
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel }
    : {
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants' as const,
      };
  return (
    <View
      testID={testID}
      {...a11y}
      style={[
        frame === 'square'
          ? { width: size, height: size, alignItems: 'center', justifyContent: 'center' }
          : { width, height },
        style,
      ]}
    >
      {figure}
    </View>
  );
}

function identity(c: string): string {
  return c;
}

/**
 * The master's joints are hairlines (a few figure units), lost below ~100 dp.
 * Each stone is shrunk about its centre so neighbours stay visibly apart:
 * ~1.5 % of the height for the faceted figure, and a clear gap (≥ 1 dp) for
 * the flat silhouette, which has no facets to tell the stones apart.
 * Returns the inset per side, in figure units.
 */
export function stoneInset(heightDp: number, mono: boolean): number {
  const gapDp = mono ? Math.max(1, heightDp * 0.06) : heightDp * 0.015;
  const k = heightDp / FIGURE_H;
  return gapDp / (2 * k);
}

function stoneTransform(s: StoneShape, inset: number): string {
  const sx = Math.max(0.5, (s.w - 2 * inset) / s.w);
  const sy = Math.max(0.5, (s.h - 2 * inset) / s.h);
  const cx = s.w / 2;
  const cy = s.h / 2;
  // Move into the figure frame, then scale about the stone's own centre.
  return `translate(${s.x + cx - cx * sx} ${s.y + cy - cy * sy}) scale(${sx} ${sy})`;
}

/**
 * One faceted stone in its own box (0 0 w h): base fill, then flat facets
 * clipped to the outline. Shared by `InukshukGlyph` and `InukshukLoader`.
 */
export function StoneArt({
  shape,
  tint,
  clipId,
}: {
  shape: StoneShape;
  tint: (hex: string) => string;
  clipId: string;
}) {
  return (
    <>
      <Defs>
        <ClipPath id={clipId}>
          <Path d={shape.outline} />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#${clipId})`}>
        <Path d={shape.outline} fill={tint(shape.base)} />
        {shape.facets.map((f, i) => (
          <Path
            key={i}
            d={f.d}
            fill={tint(f.fill)}
            stroke={tint(f.fill)}
            strokeWidth={FACET_STROKE_WIDTH}
            strokeLinejoin="bevel"
          />
        ))}
      </G>
    </>
  );
}
