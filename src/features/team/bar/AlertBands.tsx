/**
 * The active SOS / gather band (#708, mockup a–d): a state everyone sees
 * until it is resolved or ended, on the Map (in the bar's column), the Team
 * screen and the strip area; never on other tabs.
 *
 * - Others' SOS (red): "SOS · Julie Tremblay" / "640 m NE · 2 min",
 *   Navigate and Centre (an admin: Resolve). A tap on the words centres.
 * - My SOS: "Your SOS is active" / "3 of 5 received · 1 min", Resolve,
 *   confirmed inline ("Resolve for everyone?").
 * - A gather (amber, dark ink): "Gather · Lac-Delage" / "1.2 km · by Noé",
 *   Navigate; its creator (or an admin) End, confirmed inline.
 * - SOS outranks; "+1" expands to stacked bands (up to three).
 *
 * Ranking and texts are `@core/teamui/alertBands`; receipts come from the
 * session (`receipts`). Redraws on team changes and once every 30 s (ages).
 */
import {
  activeAlerts,
  bandModel,
  bandStack,
  type ActiveAlert,
  type BandAction,
} from '@core/teamui/alertBands';
import { receiptLine } from '@core/teamui/receipts';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { useTeamMapFocus } from '../map/teamMapFocus';

const AGE_TICK_MS = 30_000;

export interface AlertBandsProps {
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
  /** Centre the main map on it (the Team screen also goes to the map). */
  onCentre?: (latitude: number, longitude: number) => void;
  /** `strip`: one compact line, no expansion (the strip area). */
  variant?: 'full' | 'strip';
  style?: StyleProp<ViewStyle>;
}

/** The ranked active alerts, from the store (empty without a team). */
export function useActiveAlerts(): ActiveAlert[] {
  const soses = useTeamStore((s) => s.soses);
  const rally = useTeamStore((s) => s.rally);
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  return useMemo(() => {
    if (view === null || !view.active) return [];
    const names = new Map(view.members.map((m) => [m.id, m.name]));
    return activeAlerts({ soses, rally, me: view.me, names, positions });
  }, [soses, rally, view, positions]);
}

export function AlertBands({
  here,
  onNavigate,
  onCentre,
  variant = 'full',
  style,
}: AlertBandsProps) {
  const alerts = useActiveAlerts();
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
  const t = useSchemeTokens();
  const isAdmin = useTeamStore((s) => s.view?.isAdmin === true);
  // Receipts are re-read whenever team data changes.
  useTeamStore((s) => s.dataVersion);
  const [confirm, setConfirm] = useState(false);
  const sos = alert.kind === 'sos';
  const bg = sos ? t.team.sos : t.team.gather;
  const ink = sos ? t.team.sosInk : t.team.gatherInk;
  const receipts = alert.mine
    ? receiptLine(
        teamService()?.active?.receipts(alert.ref) ?? { received: 0, capable: 0, others: 0 },
      )
    : '';
  const m = bandModel(alert, { here, now, receipts, isAdmin });
  const id = sos ? 'team-band-sos' : 'team-band-gather';
  const finish = () => {
    const session = teamService()?.active;
    if (sos) session?.resolveSos(alert.owner, alert.ref.id);
    else session?.clearRally(alert.owner, alert.ref.id);
    useTeamStore.getState().refresh();
    setConfirm(false);
  };

  if (confirm) {
    const verb = sos ? 'Resolve' : 'End';
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
      default: {
        const verb = a === 'resolve' ? 'Resolve' : 'End';
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

  return (
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
        onPress={() => onCentre(alert.lat, alert.lng)}
        style={styles.textArea}
        accessibilityRole="button"
        accessibilityLabel={m.a11y}
        accessibilityHint="Centres the map on it"
        testID={`${id}-text`}
      >
        <View style={[styles.icon, sos ? styles.iconSos : styles.iconGather]}>
          <Icon source={sos ? 'alert-octagon' : 'flag-variant'} size={22} color={ink} />
        </View>
        <View style={styles.flex}>
          <Text style={[styles.l1, { color: ink }]} numberOfLines={1}>
            {m.title}
          </Text>
          {!compact && (
            <Text style={[styles.l2, { color: ink }]} numberOfLines={1}>
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

const shadow = {
  shadowColor: palette.shadow,
  shadowOpacity: 0.34,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 4 },
  elevation: 6,
};

const styles = StyleSheet.create({
  column: { gap: 8 },
  flex: { flex: 1, minWidth: 0 },
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
