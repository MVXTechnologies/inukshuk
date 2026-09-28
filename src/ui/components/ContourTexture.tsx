import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

/**
 * The paper screens' contour texture (revamp §5, boards `After-Library.html`
 * and `After-Empty.html`): the icon's contour lines, faint, behind a header
 * or an empty state. Started in the Library; Explore, Logbook and Settings
 * share it since 2.0.0 (owner call).
 */

// The header texture: the icon's contour lines at ~7 % (review: "a 4 %
// opacity contour-line SVG … on empty states, the Library header").
const HEADER_CONTOURS =
  'M0 13 4 14 9 18 12 24 13 30 12 37 8 42 4 44 0 45M0 130 2 118 6 110 30 93 45 66 52 59 67 50 78 28 98 12 108 0M342 0 359 2 364 6 364 12 361 24 361 32 368 46 388 72 388 78 384 90 383 98 385 106 390 117M0 169 18 160 37 136 56 120 72 102 88 92 96 84 104 74 108 66 108 48 110 42 116 36 132 31 136 28 141 8 145 0M280 0 328 27 338 38 359 64 362 74 365 100 373 126 371 160 384 182M244 20 258 19 268 21 314 45 321 50 336 66 344 79 346 92 347 116 349 136 343 182M242 40 256 41 274 48 314 74 327 86 330 98 329 138 327 154 322 165 308 180M248 63 256 62 265 66 296 86 305 96 308 104 308 114 299 144 294 152 287 160 276 169M240 104 250 103 258 104 264 108 265 112 263 124 256 136 248 142 240 144 234 143 228 139 220 130 217 124 219 118 224 112 232 107 240 104M76 170 102 116 120 92 138 77 158 50 174 23 192 13 209 0';

const EMPTY_CONTOURS =
  'M0 13 4 14 9 18 12 24 13 30 12 37 8 42 4 44 0 45M0 130 2 118 6 110 30 93 45 66 52 59 67 50 78 28 98 12 108 0M342 0 359 2 364 6 364 12 361 24 361 32 368 46 388 72 388 78 384 90 383 98 385 106 390 117M0 169 18 160 37 136 56 120 72 102 88 92 96 84 104 74 108 66 108 48 110 42 116 36 132 31 136 28 141 8 145 0M45 300 36 294 12 285 0 278M284 300 268 286 258 281 250 280 240 283 228 295 221 300M280 0 328 27 338 38 359 64 362 74 365 100 373 126 371 160 384 182 385 206 390 219M390 286 380 300M76 300 66 293 42 264 26 254 21 248 18 238 18 224 24 194 57 150 102 116 120 92 138 77 158 50 174 23 192 13 209 0M315 300 308 294 293 274 286 267 246 253 238 252 228 255 210 269 188 277 160 281 116 297 102 300M244 20 258 19 268 21 314 45 321 50 336 66 344 79 346 92 347 116 349 136 343 182 337 198 312 234 308 238 302 239 288 235 270 236 248 231 236 231 184 251 158 256 130 267 106 273 94 271 81 260 62 252 51 238 48 230 49 224 51 218 63 202 77 178 122 131 133 108 149 92 162 70 174 55 182 49 201 40 224 25 244 20M354 236 358 235 364 237 374 246 379 254 380 260 376 270 371 278 366 282 360 282 354 274 351 244 351 240 354 236M242 40 256 41 274 48 314 74 327 86 330 98 329 138 327 154 322 165 308 180 298 198 290 203 274 206 244 204 232 207 212 215 192 217 174 221 166 220 148 213 142 213 116 236 112 237 108 235 95 214 96 202 103 192 116 185 124 184 134 188 138 187 158 168 161 156 155 132 155 124 170 86 174 78 180 72 188 66 212 57 232 43 242 40M248 63 256 62 265 66 296 86 305 96 308 104 308 114 299 144 294 152 287 160 276 169 268 173 210 184 200 184 192 182 188 177 186 158 180 134 180 124 182 116 188 108 204 99 218 87 232 78 248 63M240 104 250 103 258 104 264 108 265 112 263 124 256 136 248 142 240 144 234 143 228 139 220 130 217 124 219 118 224 112 232 107 240 104';

/** Decorative contour texture, stretched to the width, never touchable. */
export function ContourTexture({
  variant,
  top = 0,
}: {
  variant: 'header' | 'empty';
  top?: number;
}) {
  const t = useSchemeTokens();
  const height = variant === 'header' ? 170 : 300;
  return (
    <View
      pointerEvents="none"
      style={[styles.texture, { top, height }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg
        width="100%"
        height={height}
        viewBox={`0 0 390 ${height}`}
        preserveAspectRatio="xMidYMin slice"
      >
        <Path
          d={variant === 'header' ? HEADER_CONTOURS : EMPTY_CONTOURS}
          fill="none"
          stroke={t.library.texture}
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

/**
 * The header texture pinned under the status bar, for a screen whose header
 * bar is transparent. Render it first, before the header and the content.
 */
export function HeaderContours() {
  const insets = useSafeAreaInsets();
  return <ContourTexture variant="header" top={insets.top} />;
}

const styles = StyleSheet.create({
  texture: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
});
