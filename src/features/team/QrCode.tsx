/**
 * A QR code (#589 invites), drawn as one SVG path: dark modules on white
 * with the 4-module quiet zone scanners need — always black on white, in the
 * dark theme too (inverted codes fail on many scanners). Encoder: `toqr`
 * (MIT, ~14 kB, already in the tree through the Expo CLI).
 */
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { toQR } from 'toqr';

const QUIET = 4;

/** The module matrix as an SVG path ("M x y h1 v1 h-1 z" runs merged per row). */
export function qrPath(text: string): { size: number; d: string } {
  const bits = toQR(text);
  const n = Math.round(Math.sqrt(bits.length));
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (bits[y * n + x] !== 1) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && bits[y * n + x] === 1) x++;
      d += `M${start + QUIET} ${y + QUIET}h${x - start}v1h${start - x}z`;
    }
  }
  return { size: n + 2 * QUIET, d };
}

export function QrCode({ text, size, testID }: { text: string; size: number; testID?: string }) {
  const { size: modules, d } = useMemo(() => qrPath(text), [text]);
  const { qrDark, qrLight } = useSchemeTokens().team;
  return (
    <View
      style={{ width: size, height: size, borderRadius: 16, overflow: 'hidden' }}
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel="Invite QR code"
    >
      <Svg width={size} height={size} viewBox={`0 0 ${modules} ${modules}`}>
        <Rect x={0} y={0} width={modules} height={modules} fill={qrLight} />
        <Path d={d} fill={qrDark} />
      </Svg>
    </View>
  );
}
