/**
 * The sender's 5 s undo (#708, mockup f): "Rally point at your position ·
 * Sends to 5 phones in 4 s" with a countdown ring and UNDO; the same for an
 * SOS after its 2 s hold. An inverse surface, never Paper's Snackbar (its
 * timer never fires on One UI). The countdown itself runs in
 * `usePendingAlert`; this leaf only redraws the ring, four times a second.
 */
import { countdownFraction, countdownSeconds } from '@core/teamui/undo';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, Text } from '@ui/paper';

import { ProgressRing } from './parts';
import { usePendingAlert } from './pendingAlert';
import { useScaledStyles } from '@ui/displayScale';

const TICK_MS = 250;
/**
 * The bar's clearance above the map's bottom column (the ⓘ + scale row): it
 * sat flush on it and read as covering the scale bar (QA 2.6.1). The SOS
 * button lifts by the same amount while the bar is up.
 */
export const UNDO_SNACK_LIFT = 8;
const ERROR_MS = 4000;

export function UndoSnack({ style }: { style: StyleProp<ViewStyle> }) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const pending = usePendingAlert((s) => s.pending);
  const error = usePendingAlert((s) => s.error);
  const undo = usePendingAlert((s) => s.undo);
  const clearError = usePendingAlert((s) => s.clearError);
  const retry = usePendingAlert((s) => s.retry);
  const phones = useTeamStore(
    (s) => (s.view?.members.filter((m) => m.active && !m.isMe).length ?? 0) as number,
  );
  const [tick, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending === null) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [pending]);
  // Never before the countdown began (the last tick may predate it).
  const now = pending === null ? tick : Math.max(tick, pending.clock.startedAt);
  // A short notice fades; a failed send never does (QA 2.6.1): it stays
  // until Retry or Dismiss.
  useEffect(() => {
    if (error === null || error.sticky) return;
    const id = setTimeout(clearError, ERROR_MS);
    return () => clearTimeout(id);
  }, [error, clearError]);

  if (pending === null) {
    if (error === null) return null;
    return (
      <View style={style} pointerEvents="box-none">
        <View
          style={[styles.snack, { backgroundColor: t.team.snack, shadowColor: palette.shadow }]}
          accessibilityLiveRegion={error.sticky ? 'assertive' : 'polite'}
          testID="team-undo-error"
        >
          <Text style={[styles.title, styles.flex, { color: t.team.snackInk }]}>{error.text}</Text>
          {error.retry !== null && (
            <Pressable
              onPress={retry}
              style={styles.undo}
              accessibilityRole="button"
              accessibilityLabel={error.retry.kind === 'sos' ? 'Retry the SOS' : 'Retry'}
              testID="team-undo-retry"
              hitSlop={6}
            >
              <Text style={[styles.undoText, { color: t.team.snackAccent }]}>RETRY</Text>
            </Pressable>
          )}
          {error.sticky && (
            <Pressable
              onPress={clearError}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              testID="team-undo-dismiss"
              hitSlop={6}
            >
              <Icon source="close" size={20} color={t.team.snackInk} />
            </Pressable>
          )}
        </View>
      </View>
    );
  }
  const secs = Math.max(1, countdownSeconds(pending.clock, now));
  const title = pending.kind === 'sos' ? 'SOS for the whole team' : 'Rally point at your position';
  const sub =
    phones === 0
      ? `Sends in ${secs} s`
      : `Sends to ${phones} phone${phones === 1 ? '' : 's'} in ${secs} s`;
  return (
    <View style={style} pointerEvents="box-none">
      <View
        style={[styles.snack, { backgroundColor: t.team.snack, shadowColor: palette.shadow }]}
        testID="team-undo-snack"
      >
        <View style={styles.ring} accessible={false}>
          <ProgressRing
            size={30}
            stroke={3}
            fraction={countdownFraction(pending.clock, now)}
            color={t.team.snackAccent}
            track={`${t.team.snackInk}38`}
          />
          {/* A glyph in a fixed ring: it does not grow with the font scale (#756). */}
          <Text style={[styles.count, { color: t.team.snackInk }]} allowFontScaling={false}>
            {secs}
          </Text>
        </View>
        <View style={styles.flex} accessible accessibilityLabel={`${title}. ${sub}`}>
          <Text style={[styles.title, { color: t.team.snackInk }]} numberOfLines={2}>
            {title}
          </Text>
          <Text style={[styles.sub, { color: t.team.snackInk }]} numberOfLines={2}>
            {sub}
          </Text>
        </View>
        <Pressable
          onPress={undo}
          style={styles.undo}
          accessibilityRole="button"
          accessibilityLabel={pending.kind === 'sos' ? 'Undo the SOS' : 'Undo the rally point'}
          testID="team-undo"
          hitSlop={6}
        >
          <Text style={[styles.undoText, { color: t.team.snackAccent }]}>UNDO</Text>
        </Pressable>
      </View>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  snack: {
    marginHorizontal: 8,
    marginBottom: UNDO_SNACK_LIFT,
    minHeight: 56,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  ring: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  count: { position: 'absolute', fontSize: 12.5, fontWeight: '900' },
  title: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  sub: { fontSize: 12.5, fontWeight: '700', opacity: 0.75 },
  undo: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center' },
  close: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  undoText: { fontSize: 14.5, fontWeight: '900', letterSpacing: 0.7 },
});
