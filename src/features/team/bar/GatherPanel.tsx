/**
 * The team panel's gather sub-panel (#743, mockup 5): while a gather is
 * active, the panel opens on it. Its head says who called it and where it is
 * from me ("1.2 km NE · by Noé"; its creator: "By you · 3 of 5 received"),
 * with Go (navigate there) and, for its creator or an admin, End, confirmed
 * inline as on the old band ("End for everyone?"). Under it, every member's
 * distance and ETA, nearest to arrive first (`gatherEtas`).
 *
 * Amber with dark ink in both themes (the gather's colours). Texts and
 * ranking are `@core/teamui/alertBands`; receipts come from the session.
 */
import { gatherEtas, gatherPanelModel, type ActiveAlert } from '@core/teamui/alertBands';
import { receiptLine } from '@core/teamui/receipts';
import { useSettingsStore } from '@state/settingsStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from '@ui/paper';
import { useSchemeTokens } from '@ui/useSchemeTokens';

import { MemberAvatar } from '../components';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

/** The ETA list scrolls past this height (a big team), dp. */
const ETAS_MAX_H = 188;

export function GatherPanel({
  alert,
  here,
  onGo,
}: {
  alert: ActiveAlert;
  here: { latitude: number; longitude: number } | null;
  /** Go: navigate to the gather (the panel closes). */
  onGo: (latitude: number, longitude: number) => void;
}) {
  const { sz } = useDisplayScale();

  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const isAdmin = useTeamStore((s) => s.view?.isAdmin === true);
  const rally = useTeamStore((s) => s.rally);
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  // Receipts are re-read whenever team data changes.
  useTeamStore((s) => s.dataVersion);
  const [confirm, setConfirm] = useState(false);
  const bg = t.team.gather;
  const ink = t.team.gatherInk;
  const receipts = alert.mine
    ? receiptLine(
        teamService()?.active?.receipts(alert.ref) ?? { received: 0, capable: 0, others: 0 },
      )
    : '';
  const m = gatherPanelModel(alert, { here, receipts, isAdmin, units });
  const rows = useMemo(
    () => (rally && view ? gatherEtas(rally, view.members, positions, here, units) : []),
    [rally, view, positions, here, units],
  );
  const byId = useMemo(() => new Map((view?.members ?? []).map((x) => [x.id, x])), [view]);
  const end = () => {
    teamService()?.active?.clearRally(alert.owner, alert.ref.id);
    useTeamStore.getState().refresh();
    setConfirm(false);
  };

  return (
    <View style={[styles.box, { backgroundColor: bg }]} testID="team-panel-gather">
      {confirm ? (
        <View style={styles.head} testID="team-panel-gather-confirm">
          <Text style={[styles.title, styles.flex, { color: ink }]} numberOfLines={2}>
            End for everyone?
          </Text>
          <Pressable
            onPress={() => setConfirm(false)}
            style={[styles.btn, styles.ghost, { borderColor: ink }]}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID="team-panel-gather-cancel"
          >
            <Text style={[styles.btnText, { color: ink }]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={end}
            style={[styles.btn, { backgroundColor: ink }]}
            accessibilityRole="button"
            accessibilityLabel="End for everyone"
            testID="team-panel-gather-confirm-yes"
          >
            <Text style={[styles.btnText, { color: bg }]}>End</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.head}>
          <Icon source="flag-variant" size={24} color={ink} />
          <View style={styles.flex} accessible accessibilityLabel={m.a11y}>
            <Text style={[styles.title, { color: ink }]} numberOfLines={1}>
              {m.title}
            </Text>
            <Text style={[styles.sub, { color: ink }]} numberOfLines={2}>
              {m.sub}
            </Text>
          </View>
          {m.canEnd && (
            <Pressable
              onPress={() => setConfirm(true)}
              style={[styles.btn, styles.ghost, { borderColor: ink }]}
              accessibilityRole="button"
              accessibilityLabel="End the gather"
              testID="team-panel-gather-end"
              hitSlop={4}
            >
              <Text style={[styles.btnText, { color: ink }]}>End</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => onGo(alert.lat, alert.lng)}
            style={[styles.btn, { backgroundColor: ink }]}
            accessibilityRole="button"
            accessibilityLabel="Go to the gather"
            testID="team-panel-gather-go"
            hitSlop={4}
          >
            <Icon source="navigation-variant" size={18} color={bg} />
            <Text style={[styles.btnText, { color: bg }]}>Go</Text>
          </Pressable>
        </View>
      )}
      <ScrollView style={styles.etas} nestedScrollEnabled testID="team-gather-etas">
        {rows.map((r) => {
          const who = byId.get(r.id);
          return (
            <View
              key={r.id}
              style={styles.eta}
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
              {who && <MemberAvatar initials={who.initials} color={who.color} size={sz(24)} />}
              <Text style={[styles.etaName, { color: ink }]} numberOfLines={1}>
                {r.isMe ? 'You' : (r.name.split(' ')[0] ?? r.name)}
              </Text>
              <Text style={[styles.etaDist, { color: ink }]}>
                {r.arrived ? 'there' : r.distance}
              </Text>
              <Text style={[styles.etaTime, { color: ink }]}>
                {r.arrived || r.etaMin === null ? '' : `${r.etaMin} min`}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  box: { marginHorizontal: 12, marginBottom: 10, borderRadius: 16, padding: 10, paddingBottom: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40 },
  title: { fontSize: 15, lineHeight: 19, fontWeight: '800' },
  sub: { fontSize: 12.5, lineHeight: 16, fontWeight: '700', opacity: 0.85 },
  btn: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ghost: { borderWidth: 1.5 },
  btnText: { fontSize: 13.5, fontWeight: '800' },
  etas: { maxHeight: ETAS_MAX_H, marginTop: 8 },
  eta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    borderTopWidth: StyleSheet.hairlineWidth,
    // The rule on amber in both themes (the old band's icon well's shade).
    borderTopColor: 'rgba(0,0,0,0.16)',
  },
  etaName: { flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: '700' },
  etaDist: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  etaTime: { width: 52, textAlign: 'right', fontSize: 13, fontWeight: '800' },
});
