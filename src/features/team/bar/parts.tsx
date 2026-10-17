/**
 * Small pieces of the team bar (#707): the faces stack, a teammate's avatar
 * in its freshness band (live, faded, hollow — the map's `ageBand`), and a
 * progress ring (the SOS hold, the undo countdown).
 */
import type { AgeBand } from '@core/teamui/positions';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Location from 'expo-location';
import { StyleSheet, View } from 'react-native';
import { Text } from '@ui/paper';
import Svg, { Circle } from 'react-native-svg';
import { useScaledStyles } from '@ui/displayScale';

/** A teammate's initials on their colour, in their freshness band. */
export function BandAvatar({
  initials,
  color,
  band,
  size,
  ring,
  live = false,
}: {
  initials: string;
  color: string;
  band: AgeBand;
  size: number;
  /** The ground it sits on (the stack's separating ring, the hollow centre). */
  ring: string;
  /** A small green dot for a live position. */
  live?: boolean;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const lost = band === 'lost';
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: lost ? ring : color,
          borderColor: lost ? color : ring,
          borderWidth: lost ? 2 : 0,
          opacity: band === 'stale' ? 0.62 : 1,
        },
      ]}
      accessible={false}
    >
      <Text
        style={[
          styles.initials,
          { fontSize: Math.round(size * 0.38), color: lost ? color : t.team.onAvatar },
        ]}
        allowFontScaling={false}
      >
        {initials}
      </Text>
      {live && band === 'fresh' && (
        <View
          style={[
            styles.live,
            { backgroundColor: t.map.gnssFixed, borderColor: ring },
            { width: size * 0.32, height: size * 0.32, borderRadius: size * 0.16 },
          ]}
        />
      )}
    </View>
  );
}

/** Overlapping faces (the pill, the panel header). */
export function FaceStack({
  faces,
  size,
  ring,
  overlap = 0.3,
}: {
  faces: readonly { id: string; initials: string; color: string; band: AgeBand }[];
  size: number;
  ring: string;
  /** How much of a face the next one covers (0–1). */
  overlap?: number;
}) {
  const styles = useScaledStyles(stylesSheet);

  return (
    <View style={styles.stack} accessible={false} testID="team-face-stack">
      {faces.map((f, i) => (
        <View
          key={f.id}
          style={[
            styles.stacked,
            { marginLeft: i === 0 ? 0 : -Math.round(size * overlap), borderColor: ring },
            { borderRadius: size / 2 + 2 },
          ]}
        >
          <BandAvatar initials={f.initials} color={f.color} band={f.band} size={size} ring={ring} />
        </View>
      ))}
    </View>
  );
}

/** A ring filled to `fraction` (0…1) clockwise from the top, over a faint track. */
export function ProgressRing({
  size,
  stroke,
  fraction,
  color,
  track,
}: {
  size: number;
  stroke: number;
  fraction: number;
  color: string;
  track: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.min(1, Math.max(0, fraction));
  return (
    <Svg width={size} height={size} pointerEvents="none">
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
      {f > 0 && (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - f)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </Svg>
  );
}

/** My position for an SOS or a rally: the map's fix, else the last known one, else null. */
export async function myPosition(
  here: { latitude: number; longitude: number } | null,
): Promise<[number, number] | null> {
  if (here !== null) return [here.longitude, here.latitude];
  try {
    const fix = await Location.getLastKnownPositionAsync();
    return fix ? [fix.coords.longitude, fix.coords.latitude] : null;
  } catch {
    return null;
  }
}

const stylesSheet = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontWeight: '800', letterSpacing: 0.2 },
  live: { position: 'absolute', right: -2, bottom: -2, borderWidth: 2 },
  stack: { flexDirection: 'row', alignItems: 'center' },
  stacked: { borderWidth: 2 },
});
