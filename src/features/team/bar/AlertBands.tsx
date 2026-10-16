/**
 * The active SOS / gather band (#708, mockup a–d): a state everyone sees
 * until it is resolved or ended, on the Map (in the bar's column), the Team
 * screen and the strip area; never on other tabs. On the map only an SOS
 * has a band (`scope="map"`, #743): a gather is the team pill's amber "!"
 * and the team panel's gather sub-panel.
 *
 * - Others' SOS (red): "SOS · Julie Tremblay" / "640 m NE · 2 min",
 *   Navigate and Centre (an admin: Resolve). A tap on the words centres.
 * - My SOS: "Your SOS is active" / "3 of 5 received · 1 min", Resolve.
 *   Resolving takes the same 2 s hold as raising (#748): the ring fills,
 *   "Let go", and letting go resolves for everyone; a tap does nothing.
 * - A gather (amber, dark ink): "Gather · Lac-Delage" (unnamed: "Gather
 *   point") / "1.2 km · by Noé" (its creator: "By you · 3 of 5 received"),
 *   Navigate; its creator (or an admin) End, confirmed inline. A tap on its
 *   words expands where it is (its coordinates, in full) and who gets there
 *   when (name, distance, ETA, nearest to arrive first; "—" without a
 *   recent position). The detail line may wrap to a second line on a narrow
 *   phone rather than cut its receipts off (QA 2.6.1).
 * - SOS outranks; "+1" expands to stacked bands (up to three).
 *
 * Ranking and texts are `@core/teamui/alertBands`; receipts come from the
 * session (`receipts`). Redraws on team changes and once every 30 s (ages).
 */
import {
  activeAlerts,
  bandModel,
  bandStack,
  gatherEtas,
  mapBandAlerts,
  type ActiveAlert,
  type BandAction,
} from '@core/teamui/alertBands';
import { receiptLine } from '@core/teamui/receipts';
import { useSettingsStore } from '@state/settingsStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, Text } from '@ui/paper';

import { useTeamMapFocus } from '../map/teamMapFocus';
import { ProgressRing } from './parts';
import { useHold } from './useHold';
import { useScaledStyles } from '@ui/displayScale';

const AGE_TICK_MS = 30_000;

export interface AlertBandsProps {
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
  /** Centre the main map on it (the Team screen also goes to the map). */
  onCentre?: (latitude: number, longitude: number) => void;
  /** `strip`: one compact line, no expansion (the strip area). */
  variant?: 'full' | 'strip';
  /**
   * `map`: SOS bands only (#743: a gather shows as the team pill's "!" and
   * in the team panel, never as a band on the map). `all` (the Team hub).
   */
  scope?: 'all' | 'map';
  style?: StyleProp<ViewStyle>;
}

/** The ranked active alerts, from the store (empty without a team). */
export function useActiveAlerts(): ActiveAlert[] {
  const soses = useTeamStore((s) => s.soses);
  const rally = useTeamStore((s) => s.rally);
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const coordinateFormat = useSettingsStore((s) => s.coordinateFormat);
  return useMemo(() => {
    if (view === null || !view.active) return [];
    const names = new Map(view.members.map((m) => [m.id, m.name]));
    return activeAlerts({ soses, rally, me: view.me, names, positions, coordinateFormat });
  }, [soses, rally, view, positions, coordinateFormat]);
}

export function AlertBands({
  here,
  onNavigate,
  onCentre,
  variant = 'full',
  scope = 'all',
  style,
}: AlertBandsProps) {
  const styles = useScaledStyles(stylesSheet);

  const every = useActiveAlerts();
  const alerts = useMemo(() => (scope === 'map' ? mapBandAlerts(every) : every), [every, scope]);
  const [expanded, setExpanded] = useState(false);
  // Ages move on every 30 s (one render of this leaf; none of the map).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);
  if (alerts.length === 0) return null;
  const open = expanded && variant === 'full' && alerts.length > 1;
  const { shown, more } = bandStack(alerts, open);
  const centre =
    onCentre ?? ((lat: number, lng: number) => useTeamMapFocus.getState().focus(lng, lat, 16));
  return (
    <View style={[styles.column, style]} pointerEvents="box-none" testID="team-alert-bands">
      {shown.map((a, i) => (
        <Band
          key={a.entity}
          alert={a}
          here={here}
          now={now}
          compact={variant === 'strip'}
          onNavigate={onNavigate}
          onCentre={centre}
          more={i === 0 && variant === 'full' ? (open ? -1 : more) : 0}
          onToggle={() => setExpanded((e) => !e)}
        />
      ))}
    </View>
  );
}

function Band({
  alert,
  here,
  now,
  compact,
  more,
  onToggle,
  onNavigate,
  onCentre,
}: {
  alert: ActiveAlert;
  here: { latitude: number; longitude: number } | null;
  now: number;
  compact: boolean;
  /** How many more alerts are folded under this band; -1: expanded. */
  more: number;
  onToggle: () => void;
  onNavigate: (latitude: number, longitude: number) => void;
  onCentre: (latitude: number, longitude: number) => void;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const isAdmin = useTeamStore((s) => s.view?.isAdmin === true);
  // Receipts are re-read whenever team data changes.
  useTeamStore((s) => s.dataVersion);
  const [confirm, setConfirm] = useState(false);
  const [etasOpen, setEtasOpen] = useState(false);
  const sos = alert.kind === 'sos';
  const bg = sos ? t.team.sos : t.team.gather;
  const ink = sos ? t.team.sosInk : t.team.gatherInk;
  const receipts = alert.mine
    ? receiptLine(
        teamService()?.active?.receipts(alert.ref) ?? { received: 0, capable: 0, others: 0 },
      )
    : '';
  const m = bandModel(alert, { here, now, receipts, isAdmin, units });
  const id = sos ? 'team-band-sos' : 'team-band-gather';
  const finish = () => {
    const session = teamService()?.active;
    if (sos) session?.resolveSos(alert.owner, alert.ref.id);
    else session?.clearRally(alert.owner, alert.ref.id);
    useTeamStore.getState().refresh();
    setConfirm(false);
  };

  // Only a gather's End is confirmed inline; an SOS is resolved by a hold (#748).
  if (confirm) {
    const verb = 'End';
    return (
      <View
        style={[styles.band, { backgroundColor: bg, borderColor: t.team.mapHalo }, shadow]}
        testID={`${id}-confirm`}
      >
        <Text style={[styles.l1, styles.flex, { color: ink }]} numberOfLines={2}>
          {`${verb} for everyone?`}
        </Text>
        <Pressable
          onPress={() => setConfirm(false)}
          style={[styles.textButton, styles.ghost]}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          testID={`${id}-cancel`}
        >
          <Text style={[styles.textButtonLabel, { color: ink }]}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={finish}
          style={[styles.textButton, { backgroundColor: ink }]}
          accessibilityRole="button"
          accessibilityLabel={`${verb} for everyone`}
          testID={`${id}-confirm-yes`}
        >
          <Text style={[styles.textButtonLabel, { color: bg }]}>{verb}</Text>
        </Pressable>
      </View>
    );
  }

  const button = (a: BandAction) => {
    switch (a) {
      case 'navigate':
        return (
          <Round
            key={a}
            icon="navigation-variant"
            label={`Navigate to ${sos ? alert.ownerName : 'the gather'}`}
            filled
            bg={bg}
            ink={ink}
            onPress={() => onNavigate(alert.lat, alert.lng)}
            testID={`${id}-navigate`}
          />
        );
      case 'centre':
        return (
          <Round
            key={a}
            icon="image-filter-center-focus"
            label="Centre the map on it"
            bg={bg}
            ink={ink}
            onPress={() => onCentre(alert.lat, alert.lng)}
            testID={`${id}-centre`}
          />
        );
      case 'resolve':
        return (
          <HoldResolve
            key={a}
            bg={bg}
            ink={ink}
            mine={alert.mine}
            onResolve={finish}
            testID={`${id}-resolve`}
          />
        );
      default: {
        const verb = 'End';
        return (
          <Pressable
            key={a}
            onPress={() => setConfirm(true)}
            style={[styles.textButton, { backgroundColor: ink }]}
            accessibilityRole="button"
            accessibilityLabel={verb}
            testID={`${id}-${a}`}
          >
            <Text style={[styles.textButtonLabel, { color: bg }]}>{verb}</Text>
          </Pressable>
        );
      }
    }
  };

  // A gather's words open who gets there when (the old rally pill's list).
  const etaToggle = !sos && !compact;
  const band = (
    <View
      style={[
        styles.band,
        compact && styles.compact,
        { backgroundColor: bg, borderColor: t.team.mapHalo },
        shadow,
      ]}
      testID={id}
    >
      <Pressable
        onPress={() => (etaToggle ? setEtasOpen((o) => !o) : onCentre(alert.lat, alert.lng))}
        style={styles.textArea}
        accessibilityRole="button"
        accessibilityLabel={m.a11y}
        accessibilityHint={
          etaToggle
            ? etasOpen
              ? 'Hides who gets there when'
              : 'Shows who gets there when'
            : 'Centres the map on it'
        }
        accessibilityState={etaToggle ? { expanded: etasOpen } : undefined}
        testID={`${id}-text`}
      >
        {m.tag !== null ? (
          // "SOS" in the badge (#756): the title keeps the whole width for the name.
          <View style={[styles.icon, styles.tag, { backgroundColor: ink }]} testID={`${id}-tag`}>
            <Text style={[styles.tagText, { color: bg }]} allowFontScaling={false}>
              {m.tag}
            </Text>
          </View>
        ) : (
          <View style={[styles.icon, sos ? styles.iconSos : styles.iconGather]}>
            <Icon source={sos ? 'alert-octagon' : 'flag-variant'} size={22} color={ink} />
          </View>
        )}
        <View style={styles.flex}>
          {/* The fold chevron rides the title line: the detail line keeps the width. */}
          <View style={styles.titleRow}>
            <Text
              style={[styles.l1, styles.shrink, { color: ink }]}
              numberOfLines={m.tag !== null ? 2 : 1}
            >
              {m.title}
            </Text>
            {etaToggle && (
              <Icon source={etasOpen ? 'chevron-up' : 'chevron-down'} size={18} color={ink} />
            )}
          </View>
          {!compact && (
            <Text style={[styles.l2, { color: ink }]} numberOfLines={2}>
              {m.sub}
            </Text>
          )}
        </View>
      </Pressable>
      {more !== 0 && (
        <Pressable
          onPress={onToggle}
          style={[styles.plus, { backgroundColor: t.team.gather }]}
          accessibilityRole="button"
          accessibilityLabel={
            more > 0 ? `${more} more active alert${more === 1 ? '' : 's'}` : 'Fold the alerts'
          }
          testID="team-band-more"
          hitSlop={8}
        >
          {more > 0 ? (
            <Text style={[styles.plusText, { color: t.team.gatherInk }]}>{`+${more}`}</Text>
          ) : (
            <Icon source="chevron-up" size={16} color={t.team.gatherInk} />
          )}
        </Pressable>
      )}
      {m.actions.map(button)}
    </View>
  );
  if (!etaToggle || !etasOpen) return band;
  return (
    <View style={styles.column} pointerEvents="box-none">
      {band}
      <GatherEtaList here={here} coords={alert.coords} />
    </View>
  );
}

/**
 * Who gets there when (the old rally pill's ETA list): every member's
 * distance and ETA to the rally point, nearest to arrive first; "—" without
 * a recent position (`gatherEtas`). Redraws with team changes only.
 */
function GatherEtaList({
  here,
  coords,
}: {
  here: { latitude: number; longitude: number } | null;
  /** The gather's coordinates in the user's format, in full. */
  coords: string;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const rally = useTeamStore((s) => s.rally);
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const units = useSettingsStore((s) => s.units);
  const rows = useMemo(
    () => (rally && view ? gatherEtas(rally, view.members, positions, here, units) : []),
    [rally, view, positions, here, units],
  );
  return (
    <View
      style={[styles.etas, { backgroundColor: t.surface, borderColor: t.team.gather }, shadow]}
      testID="team-gather-etas"
    >
      <Text
        style={[styles.etaPlace, { color: t.inkMuted }]}
        selectable
        accessibilityLabel={`At ${coords}`}
        testID="team-gather-coords"
      >
        {coords}
      </Text>
      {rows.map((r) => (
        <View
          key={r.id}
          style={styles.etaRow}
          accessible
          accessibilityLabel={
            r.etaMin === null && !r.arrived
              ? `${r.name}: position unknown`
              : r.arrived
                ? `${r.name}: there`
                : `${r.name}: ${r.distance}, about ${r.etaMin} minutes`
          }
          testID={`team-gather-eta-${r.name}`}
        >
          <Text style={[styles.etaName, { color: t.ink }]} numberOfLines={1}>
            {r.name}
          </Text>
          <Text style={[styles.etaDist, { color: t.inkMuted }]}>{r.distance}</Text>
          <Text
            style={[
              styles.etaEta,
              { color: r.arrived ? t.status.gnssFixed : r.etaMin === null ? t.inkMuted : t.ink },
            ]}
          >
            {r.eta}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** How long "Hold" stays reworded after a short tap, ms. */
const HOLD_HINT_MS = 2500;

/**
 * Resolve, by the same hold as raising (#748): a round button in a ring
 * that fills over 2 s, a tick each second, "Let go" once armed; letting go
 * resolves for everyone. A short tap only says to hold. TalkBack and
 * VoiceOver users double-tap and hold, or use the "Resolve for everyone"
 * action.
 */
function HoldResolve({
  bg,
  ink,
  mine,
  onResolve,
  testID,
}: {
  bg: string;
  ink: string;
  mine: boolean;
  onResolve: () => void;
  testID: string;
}) {
  const styles = useScaledStyles(stylesSheet);

  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(false), HOLD_HINT_MS);
    return () => clearTimeout(id);
  }, [hint]);
  const hold = useHold({ onFire: onResolve, onShort: () => setHint(true) });
  const under =
    hold.phase === 'armed'
      ? 'Let go'
      : hold.phase === 'holding'
        ? `${hold.secondsLeft} s`
        : hint
          ? 'Hold 2 s'
          : 'Resolve';
  const what = mine ? 'your SOS' : 'the SOS';
  return (
    <View style={styles.hold} testID={`${testID}-hold`}>
      <View style={styles.holdRing}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <ProgressRing
            size={HOLD_RING}
            stroke={3}
            fraction={hold.fraction}
            color={ink}
            track={`${ink}4D`}
          />
        </View>
        <Pressable
          onPressIn={hold.down}
          onPressOut={hold.up}
          style={[styles.holdButton, { backgroundColor: ink }]}
          accessibilityRole="button"
          accessibilityLabel={
            hold.phase === 'armed'
              ? `Let go to resolve ${what} for everyone`
              : `Resolve ${what}. Hold for two seconds`
          }
          accessibilityHint="Touch and hold"
          accessibilityState={{ busy: hold.phase !== 'idle' }}
          accessibilityActions={[{ name: 'longpress', label: 'Resolve for everyone' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'longpress') onResolve();
          }}
          testID={testID}
        >
          <Icon source="check-bold" size={20} color={bg} />
        </Pressable>
      </View>
      <Text
        style={[styles.holdLabel, { color: ink }]}
        allowFontScaling={false}
        accessible={false}
        testID={`${testID}-label`}
      >
        {under}
      </Text>
    </View>
  );
}

function Round({
  icon,
  label,
  filled = false,
  bg,
  ink,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  filled?: boolean;
  bg: string;
  ink: string;
  onPress: () => void;
  testID: string;
}) {
  const styles = useScaledStyles(stylesSheet);

  return (
    <Pressable
      onPress={onPress}
      style={[styles.round, filled ? { backgroundColor: ink } : styles.ghost]}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={4}
    >
      <Icon source={icon} size={22} color={filled ? bg : ink} />
    </Pressable>
  );
}

const HOLD_RING = 42;

const shadow = {
  shadowColor: palette.shadow,
  shadowOpacity: 0.34,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 4 },
  elevation: 6,
};

const stylesSheet = StyleSheet.create({
  column: { gap: 8 },
  etas: { borderRadius: 16, borderWidth: 1.5, paddingVertical: 4, paddingHorizontal: 12 },
  etaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  etaName: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700' },
  etaDist: { fontSize: 13, fontWeight: '700', minWidth: 56, textAlign: 'right' },
  etaEta: { fontSize: 13.5, fontWeight: '800', minWidth: 64, textAlign: 'right' },
  flex: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  etaPlace: { fontSize: 13, fontWeight: '700', paddingTop: 6, paddingBottom: 2 },
  band: {
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingLeft: 8,
    paddingRight: 8,
  },
  compact: { minHeight: 44, borderRadius: 14 },
  textArea: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  icon: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  iconSos: { borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.2)' },
  tag: { borderRadius: 16 },
  tagText: { fontSize: 10.5, lineHeight: 13, fontWeight: '900', letterSpacing: 0.3 },
  iconGather: { borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.12)' },
  l1: { fontSize: 14.5, lineHeight: 18, fontWeight: '800' },
  l2: { fontSize: 12.5, lineHeight: 17, fontWeight: '700' },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { backgroundColor: 'rgba(255,255,255,0.2)' },
  hold: { alignItems: 'center', minWidth: 52 },
  holdRing: {
    width: HOLD_RING,
    height: HOLD_RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  holdButton: {
    width: HOLD_RING - 10,
    height: HOLD_RING - 10,
    borderRadius: (HOLD_RING - 10) / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  holdLabel: { marginTop: -2, fontSize: 10.5, lineHeight: 13, fontWeight: '800' },
  textButton: {
    minHeight: 38,
    borderRadius: 19,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textButtonLabel: { fontSize: 14, fontWeight: '800' },
  plus: {
    minWidth: 26,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: { fontSize: 11, fontWeight: '900' },
});
