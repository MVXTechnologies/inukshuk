import { heightSystem } from '@core/convert/systems';
import {
  coordDecimals,
  formatAccuracy,
  formatAge,
  formatHeight,
  formatLatLon,
  kindLabel,
  type ReceiverChip,
} from '@core/gnss/chip';
import { activeProfile, correctionsOf, profileLine } from '@core/gnss/config';
import { receiverFrame, receiverFrameLabel } from '@core/gnss/datum';
import type { PositionResult } from '@core/gnss/output';
import { projectDatumOption } from '@core/gnss/projectDatum';
import { usesCorrections } from '@core/gnss/quality';
import { BASELINE_WARN_KM } from '@core/gnss/sourcetable';
import { useGnssStore } from '@state/gnssStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReceiverChipView } from './ReceiverChipView';

function Row({ label, children }: { label: string; children: ReactNode }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: t.inkMuted }]}>{label.toUpperCase()}</Text>
      <View style={styles.rowBody}>{children}</View>
    </View>
  );
}

/** Root-sum-square of the receiver's and the conversion's stated accuracies. */
export function totalAccuracy(receiverM: number | null, datumM: number | null): number | null {
  if (receiverM === null || datumM === null) return null;
  return Math.sqrt(receiverM * receiverM + datumM * datumM);
}

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const k = 111.32;
  const dx = (bLon - aLon) * k * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, (bLat - aLat) * k);
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The receiver's detail sheet (mockup `gnss-rtk`): the state and since when,
 * satellites, accuracies, corrections, and the position in the project datum
 * WITH its method and stated accuracy — or Convert's refusal, never a guess;
 * "⚠ frame unknown" when the caster declares no frame (owner A5). A plain
 * view over the map (no Portal: it can open while recording).
 */
export function ReceiverSheet({ chip }: { chip: ReceiverChip }) {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const now = useNow();
  const close = useGnssStore((s) => s.setSheetOpen);
  const config = useGnssStore((s) => s.config);
  const fix = useGnssStore((s) => s.fix);
  const status = useGnssStore((s) => s.status);
  const sky = useGnssStore((s) => s.sky);
  const map = useGnssStore((s) => s.map);
  const project = useGnssStore((s) => s.project);
  const ntrip = useGnssStore((s) => s.ntrip);
  const use = useGnssStore((s) => s.use);
  const phone = useGnssStore((s) => s.phone);

  const receiverName = config.receiver?.name ?? 'Receiver';
  const profile = activeProfile(config);
  const option = projectDatumOption(config.projectDatumId);
  const frame = fix ? receiverFrame(fix.kind, correctionsOf(config)) : null;
  const acc = fix?.accuracy ?? null;
  const approx = acc?.basis === 'hdop';
  const since =
    status && status.state !== 'no-fix' && status.sinceMs > 0
      ? formatAge((now - status.sinceMs) / 1000)
      : '';

  const satsLine =
    fix?.satsUsed != null
      ? `${fix.satsUsed}${fix.satsInView != null ? ` of ${fix.satsInView}` : ''} satellites`
      : sky.length > 0
        ? `${sky.length} satellites in view`
        : null;

  return (
    <View style={[StyleSheet.absoluteFill, styles.layer]} pointerEvents="box-none">
      <Pressable
        style={[StyleSheet.absoluteFill, styles.scrim]}
        onPress={() => close(false)}
        accessibilityLabel="Close receiver details"
        accessibilityRole="button"
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: t.surface,
            paddingBottom: insets.bottom + 12,
            shadowColor: palette.shadow,
          },
        ]}
        testID="gnss-receiver-sheet"
      >
        <View style={[styles.grabber, { backgroundColor: t.outlineVariant }]} />
        <View style={styles.header}>
          <View style={[styles.badge, { backgroundColor: t.surfaceVariant }]}>
            <Icon source="satellite-variant" size={22} color={t.ink} />
          </View>
          <View style={styles.flex}>
            <Text
              accessibilityRole="header"
              style={[styles.title, { color: t.ink }]}
              numberOfLines={1}
            >
              {receiverName}
            </Text>
            <Text style={[styles.subtitle, { color: t.inkVariant }]} numberOfLines={1}>
              {use === 'external'
                ? `Your location · phone GPS ${phone === 'off' ? 'off' : 'in standby'}`
                : 'Your location uses the phone GPS'}
            </Text>
          </View>
          <IconButton icon="close" onPress={() => close(false)} accessibilityLabel="Close" />
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <View style={styles.pills}>
            <ReceiverChipView chip={chip} variant="surface" />
            {since !== '' && fix && <Pill text={`${kindLabel(fix.kind)} for ${since}`} />}
            {satsLine !== null && <Pill text={satsLine} />}
            {fix?.hdop != null && <Pill text={`HDOP ${fix.hdop.toFixed(1)}`} />}
          </View>

          <View style={styles.tiles}>
            <Tile
              label="Horizontal"
              value={acc ? formatAccuracy(acc.h95, acc.basis) : '—'}
              tint={status?.state === 'fixed'}
            />
            <Tile
              label="Vertical"
              value={acc?.v95 != null ? formatAccuracy(acc.v95, acc.basis) : '—'}
              tint={false}
            />
          </View>
          <Text style={[styles.caption, { color: t.inkMuted }]}>
            {approx
              ? '95 % estimate from HDOP — this receiver reports no error estimate (≈)'
              : 'The receiver’s own 95 % estimate'}
          </Text>

          <Row label="Corrections">
            <Text style={[styles.body, { color: t.ink }]}>
              {profile ? profileLine(profile) : 'None from Inukshuk'}
            </Text>
            <Text style={[styles.small, { color: t.inkVariant }]}>
              {correctionLine(profile, ntrip, fix, status?.correctionAgeS ?? null)}
            </Text>
          </Row>

          <Row label="Position">
            {fix === null ? (
              <Text style={[styles.body, { color: t.inkVariant }]}>Waiting for a fix…</Text>
            ) : (
              <PositionBlock
                result={project}
                receiverAccM={acc?.h95 ?? null}
                receiverVAccM={acc?.v95 ?? null}
                label={option.label}
              />
            )}
            {frame !== null && frame.frameUnknown && (
              <View style={styles.warnRow}>
                <Icon source="alert-outline" size={16} color={t.status.gpsWeak} />
                <Text style={[styles.small, styles.flex, { color: t.status.gpsWeak }]}>
                  Frame unknown — the caster doesn’t say which datum its base uses; WGS 84 assumed
                </Text>
              </View>
            )}
            {frame !== null && !frame.frameUnknown && (
              <Text style={[styles.small, { color: t.inkVariant }]}>
                Received in {receiverFrameLabel(frame)}
              </Text>
            )}
          </Row>

          <Row label="On the map">
            {map === null ? (
              <Text style={[styles.small, { color: t.inkVariant }]}>—</Text>
            ) : (
              <MapLine result={map.result} />
            )}
          </Row>

          <View style={styles.actions}>
            <Button
              mode="outlined"
              icon="cog-outline"
              onPress={() => {
                close(false);
                router.push('/settings');
              }}
            >
              Receiver settings
            </Button>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function correctionLine(
  profile: ReturnType<typeof activeProfile>,
  ntrip: { phase: string; message: string | null; bytes: number },
  fix: { kind: Parameters<typeof usesCorrections>[0]; lat: number; lon: number } | null,
  ageS: number | null,
): string {
  if (profile === null) {
    return fix && usesCorrections(fix.kind)
      ? 'The receiver gets corrections on its own (radio or its own NTRIP)'
      : 'Add an NTRIP caster in Settings for RTK';
  }
  if (ntrip.phase === 'error' || ntrip.phase === 'unavailable')
    return ntrip.message ?? 'Not connected';
  if (ntrip.phase === 'connecting') return 'Connecting to the caster…';
  const parts = ['RTCM 3 over the phone’s data'];
  if (fix && profile.baseLat !== null && profile.baseLon !== null) {
    const km = distanceKm(fix.lat, fix.lon, profile.baseLat, profile.baseLon);
    parts.push(
      `base ${km.toFixed(1)} km${km > BASELINE_WARN_KM ? ' (long baseline: RTK less reliable)' : ''}`,
    );
  }
  if (ageS !== null) parts.push(`age ${formatAge(ageS)}`);
  return parts.join(' · ');
}

function PositionBlock({
  result,
  receiverAccM,
  receiverVAccM,
  label,
}: {
  result: PositionResult | null;
  receiverAccM: number | null;
  receiverVAccM: number | null;
  label: string;
}) {
  const t = useSchemeTokens();
  if (result === null) return null;
  if (!result.ok) {
    return (
      <>
        <Text style={[styles.body, { color: t.status.gpsLostInk }]}>Not converted to {label}</Text>
        <Text style={[styles.small, { color: t.inkVariant }]}>{result.refusal.message}</Text>
      </>
    );
  }
  const { plan, value } = result;
  const total = totalAccuracy(receiverAccM, plan.datumAccuracyM);
  const hName = plan.height === null ? null : (heightSystem(plan.height)?.name ?? plan.height);
  const vTotal = totalAccuracy(receiverVAccM, plan.datumAccuracyM);
  return (
    <>
      <Text style={[styles.mono, { color: t.ink }]} selectable>
        {formatLatLon(value.lat, value.lon, coordDecimals(total ?? receiverAccM))}
      </Text>
      {value.h !== null && (
        <Text style={[styles.mono, { color: t.ink }]} selectable>
          h {formatHeight(value.h, vTotal ?? receiverVAccM)}
          {hName ? ` · ${hName}` : ''}
        </Text>
      )}
      <Text style={[styles.small, { color: t.inkVariant }]}>{plan.outputLabel}</Text>
      <Text style={[styles.small, { color: t.inkVariant }]}>Method: {plan.method}</Text>
      <Text style={[styles.small, { color: t.inkVariant }]}>
        Stated accuracy:{' '}
        {total === null
          ? 'not stated'
          : plan.datumAccuracyM === 0
            ? `${formatAccuracy(total)} (the receiver’s; no conversion)`
            : `${formatAccuracy(total)} (receiver ${formatAccuracy(receiverAccM ?? 0)}, conversion ${formatAccuracy(plan.datumAccuracyM ?? 0)})`}
      </Text>
      {plan.validation.length > 0 && (
        <Text style={[styles.small, { color: t.inkMuted }]}>
          Validated against: {plan.validation.join(', ')}
        </Text>
      )}
    </>
  );
}

function MapLine({ result }: { result: PositionResult }) {
  const t = useSchemeTokens();
  if (!result.ok) {
    return (
      <>
        <Text style={[styles.body, { color: t.status.gpsWeak }]}>
          Drawn where the receiver puts it
        </Text>
        <Text style={[styles.small, { color: t.inkVariant }]}>{result.refusal.message}</Text>
      </>
    );
  }
  const moved = result.plan.plan !== null;
  return (
    <>
      <Text style={[styles.body, { color: t.ink }]}>WGS 84</Text>
      <Text style={[styles.small, { color: t.inkVariant }]}>
        {moved
          ? `${result.plan.method} · ${result.plan.datumAccuracyM !== null ? formatAccuracy(result.plan.datumAccuracyM) : 'accuracy not stated'}`
          : 'As received'}
      </Text>
    </>
  );
}

function Pill({ text }: { text: string }) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.pill, { backgroundColor: t.surfaceVariant }]}>
      <Text style={[styles.pillText, { color: t.ink }]}>{text}</Text>
    </View>
  );
}

function Tile({ label, value, tint }: { label: string; value: string; tint: boolean }) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.tile, { backgroundColor: t.surfaceVariant }]}
      accessible
      accessibilityLabel={`${label} accuracy ${value}`}
    >
      <Text style={[styles.tileLabel, { color: t.inkVariant }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.tileValue, { color: tint ? t.status.gnssFixed : t.ink }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Above the map's controls rail and the recording panel.
  layer: { zIndex: 50, elevation: 50 },
  warnRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: 2 },
  scrim: { backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '78%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 12,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingTop: 6 },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  title: { fontSize: 18, fontWeight: '700' },
  subtitle: { fontSize: 13, marginTop: 2 },
  scroll: { flexGrow: 0 },
  content: { paddingHorizontal: 16, paddingTop: 8, gap: 12 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  pill: { height: 28, paddingHorizontal: 11, borderRadius: 14, justifyContent: 'center' },
  pillText: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tiles: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, borderRadius: 16, padding: 14 },
  tileLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  tileValue: { fontSize: 26, fontWeight: '800', marginTop: 4, fontVariant: ['tabular-nums'] },
  caption: { fontSize: 12, marginTop: -4 },
  row: { flexDirection: 'row', gap: 12 },
  rowLabel: { width: 96, fontSize: 12, fontWeight: '700', letterSpacing: 1, paddingTop: 2 },
  rowBody: { flex: 1, gap: 2 },
  body: { fontSize: 15 },
  small: { fontSize: 13 },
  mono: { fontSize: 15, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 4, paddingBottom: 8 },
});
