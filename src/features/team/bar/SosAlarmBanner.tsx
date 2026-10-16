/**
 * The in-app SOS alarm (#708, mockup e): when a teammate's SOS first
 * arrives with the app open, a full-width red banner over every screen, a
 * red edge glow, the alarm tone and a repeating long vibration until
 * Acknowledge (or Navigate, which also acknowledges). It collapses into the
 * band, which stays until the SOS is resolved; a resolve clears it too.
 *
 * Sound: no audio player ships in this binary, so the alarm re-posts the
 * SOS notification under the same id (the system plays the "Team SOS"
 * tone each time, its system banner hidden while this one is up) every
 * {@link RESOUND_MS}, the tone's own 8 s length: F → D → F → D with no gap
 * and no overlap (the tone ends in 0.15 s of silence, slack for timer
 * jitter). The vibration repeats natively. Both go on until Acknowledge (or
 * Navigate), a resolve, or the banner unmounting; never on a timeout. A plain absolutely positioned View: never a Paper
 * Portal on this spontaneous path (paper-portal-touch-swallow).
 */
import { metres } from '@core/teamui/field';
import { compassPoint, shortAge } from '@core/teamui/positions';
import { distanceText } from '@core/teamui/teamBar';
import { initialBearingDeg } from '@core/geo/geomath';
import { notifyTeam, SOS_TONE_MS, SOS_VIBRATION } from '@data/team/teamNotifications';
import { useNavigationStore } from '@state/navigationStore';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Vibration, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** How often the tone sounds again: exactly its length, so it loops seamlessly. */
export const RESOUND_MS = SOS_TONE_MS;

export function SosAlarmBanner() {
  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const alarm = useTeamStore((s) => s.sosAlarm);
  const acknowledge = useTeamStore((s) => s.acknowledgeAlarm);
  const sos = useTeamStore((s) =>
    s.sosAlarm === null
      ? undefined
      : s.soses.find((x) => `sos:${x.owner}:${x.id}` === s.sosAlarm?.entity),
  );
  const live = useTeamStore((s) =>
    s.sosAlarm === null ? undefined : s.positions.find((p) => p.id === s.sosAlarm?.owner),
  );
  const here = useSettingsStore((s) => s.lastKnownPosition);
  const entity = alarm?.entity ?? null;
  // A new ring for the same SOS (reopened after a resolve): the alarm starts over.
  const rangAt = alarm?.at ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (entity === null) return;
    const pattern = SOS_VIBRATION;
    Vibration.vibrate(pattern, true);
    const id = setInterval(() => {
      setNow(Date.now());
      const a = useTeamStore.getState().sosAlarm;
      if (a === null) {
        clearInterval(id);
        Vibration.cancel();
        return;
      }
      if (AppState.currentState !== 'active') return;
      void notifyTeam({
        title: `SOS · ${a.authorName}`,
        body: `Needs help · ${a.teamName}`,
        url: `/team/sos/${a.owner}/${a.entity.split(':')[2] ?? ''}`,
        channel: 'sos',
        identifier: a.entity,
      });
    }, RESOUND_MS);
    return () => {
      clearInterval(id);
      Vibration.cancel();
    };
  }, [entity, rangAt]);

  if (alarm === null) return null;
  const at: [number, number] | null = live ? [live.lon, live.lat] : sos ? [sos.lng, sos.lat] : null;
  const where =
    at && here
      ? `${distanceText(metres([here.longitude, here.latitude], at), units)} ${compassPoint(
          initialBearingDeg(here, { latitude: at[1], longitude: at[0] }),
        )} of you`
      : null;
  const age = shortAge(Math.max(now, alarm.at) - (sos?.at ?? alarm.at));
  const sub = ['Needs help', where, age === 'now' ? 'just now' : `${age} ago`]
    .filter(Boolean)
    .join(' · ');
  const navigate = () => {
    acknowledge();
    if (at) useNavigationStore.getState().setDestination({ latitude: at[1], longitude: at[0] });
    router.navigate('/' as never);
  };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="team-sos-alarm">
      <View
        style={[styles.edge, { borderColor: t.team.sos, shadowColor: t.team.sos }]}
        pointerEvents="none"
      />
      <View
        style={[
          styles.banner,
          { top: insets.top + 6, backgroundColor: t.team.sos, shadowColor: palette.shadow },
        ]}
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
      >
        <View style={styles.head}>
          <View style={styles.bell}>
            <Icon source="alert-octagon" size={30} color={t.team.sosInk} />
          </View>
          <View style={styles.flex}>
            <Text style={[styles.t1, { color: t.team.sosInk }]} numberOfLines={1}>
              {`SOS · ${alarm.authorName}`}
            </Text>
            <Text style={[styles.t2, { color: t.team.sosInk }]} numberOfLines={2}>
              {sub}
            </Text>
          </View>
        </View>
        <View style={styles.vr}>
          <Icon source="vibrate" size={17} color={t.team.sosInk} />
          <Text style={[styles.vrText, { color: t.team.sosInk }]}>
            Sounding and vibrating until you acknowledge
          </Text>
        </View>
        <View style={styles.btns}>
          <Pressable
            onPress={acknowledge}
            style={[styles.btn, styles.primary, { backgroundColor: t.team.sosInk }]}
            accessibilityRole="button"
            accessibilityLabel="Acknowledge the SOS"
            testID="team-sos-acknowledge"
          >
            <Icon source="check" size={20} color={t.team.sos} />
            <Text style={[styles.btnText, { color: t.team.sos }]}>Acknowledge</Text>
          </Pressable>
          <Pressable
            onPress={navigate}
            style={[styles.btn, styles.ghost]}
            accessibilityRole="button"
            accessibilityLabel={`Navigate to ${alarm.authorName}`}
            testID="team-sos-alarm-navigate"
          >
            <Icon source="navigation-variant" size={20} color={t.team.sosInk} />
            <Text style={[styles.btnText, { color: t.team.sosInk }]}>Navigate</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  edge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 4,
    shadowOpacity: 0.6,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 0 },
  },
  banner: {
    position: 'absolute',
    left: 8,
    right: 8,
    borderRadius: 26,
    padding: 14,
    paddingBottom: 12,
    shadowOpacity: 0.42,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 14 },
    elevation: 16,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bell: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  t1: { fontSize: 18, lineHeight: 22, fontWeight: '800' },
  t2: { fontSize: 14, lineHeight: 19, fontWeight: '700' },
  vr: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  vrText: { fontSize: 12.5, fontWeight: '700' },
  btns: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btn: {
    height: 46,
    borderRadius: 23,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  primary: { flex: 1.3 },
  ghost: { flex: 1, backgroundColor: 'rgba(255,255,255,0.2)' },
  btnText: { fontSize: 15, fontWeight: '800' },
});
