/**
 * A drawing's card (#683, mockup frame 9b): a tap on a shape outside drawing
 * mode. Its author and kind, its age and where Navigate goes, its note, a
 * life bar with the time left, and Navigate · Centre · Message, plus Delete
 * for its author or an admin (absent otherwise, never greyed). Back closes it.
 * The same card style as a teammate's popup; a plain themed View.
 */
import { ageText, lifeText, navTarget, SHAPE_NAMES, whereText } from '@core/teamdraw/card';
import { memberColor } from '@core/teamui/colors';
import type { DrawShape } from '@core/teamdraw/view';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamDrawStore } from '@state/teamDrawStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { IconButton, Text } from '@ui/paper';

import { MemberAvatar } from '../components';
import { Round } from '../map/TeamCards';
import { useTeamMapFocus } from '../map/teamMapFocus';
import { useScaledStyles } from '@ui/displayScale';

/** The card for the shape whose key is in the drawing store, or nothing. */
export function TeamShapeCard({
  here,
  onNavigate,
  screenFocused = true,
}: {
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
  /** The map screen is focused: Back closes the card only then (2.5.1 review rule). */
  screenFocused?: boolean;
}) {
  const key = useTeamDrawStore((s) => s.card);
  const shape = useTeamStore((s) =>
    key === null ? undefined : s.drawings.find((d) => d.key === key),
  );
  // A shape that faded or was deleted while its card was up: the card goes.
  useEffect(() => {
    if (key !== null && shape === undefined) useTeamDrawStore.getState().openCard(null);
  }, [key, shape]);
  if (shape === undefined) return null;
  return <Card shape={shape} here={here} onNavigate={onNavigate} focused={screenFocused} />;
}

function Card({
  shape,
  here,
  onNavigate,
  focused,
}: {
  shape: DrawShape;
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
  focused: boolean;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const router = useRouter();
  const view = useTeamStore((s) => s.view);
  const units = useSettingsStore((s) => s.units);
  const [now, setNow] = useState(() => teamService()?.active?.draw.clock() ?? Date.now());
  useEffect(() => {
    const timer = setInterval(
      () => setNow(teamService()?.active?.draw.clock() ?? Date.now()),
      5_000,
    );
    return () => clearInterval(timer);
  }, []);
  const close = () => useTeamDrawStore.getState().openCard(null);
  // Tab screens stay mounted: on another tab, Back must navigate there, not
  // close a card nobody can see.
  useEffect(() => {
    if (!focused) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      useTeamDrawStore.getState().openCard(null);
      return true;
    });
    return () => sub.remove();
  }, [focused]);

  const author = view?.members.find((m) => m.id === shape.owner);
  const mine = shape.owner === view?.me;
  const canDelete = mine || (view?.isAdmin ?? false);
  const life = lifeText(shape, now);
  const where = whereText(shape, here ? [here.longitude, here.latitude] : null, units);
  const target = navTarget(shape);
  const color = memberColor(shape.c);
  return (
    <View
      style={[styles.card, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}
      testID="team-shape-card"
    >
      <View style={styles.head}>
        <MemberAvatar initials={author?.initials ?? '?'} color={author?.color ?? color} size={36} />
        <View style={styles.flex}>
          <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={1}>
            {`${mine ? 'You' : (author?.name ?? 'A teammate')} · ${SHAPE_NAMES[shape.sh]}`}
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: t.inkVariant }}
            numberOfLines={1}
            testID="team-shape-card-sub"
          >
            {[ageText(shape.created, now), where].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <IconButton icon="close" size={20} onPress={close} accessibilityLabel="Close" />
      </View>
      {shape.tx.length > 0 && (
        <Text
          variant="titleSmall"
          style={[styles.note, { color: t.ink }]}
          testID="team-shape-card-note"
        >
          {`“${shape.tx}”`}
        </Text>
      )}
      {life.left !== null && (
        <View style={[styles.life, { backgroundColor: t.surfaceVariant }]}>
          <View
            style={[
              styles.lifeFill,
              { width: `${Math.round(life.left * 100)}%`, backgroundColor: color },
            ]}
            testID="team-shape-card-life"
          />
        </View>
      )}
      <View style={styles.lifeCap}>
        <Text variant="bodySmall" style={{ color: t.inkMuted }} testID="team-shape-card-left">
          {life.text}
        </Text>
        {life.of !== null && (
          <Text variant="bodySmall" style={{ color: t.inkMuted }}>
            {life.of}
          </Text>
        )}
      </View>
      <View style={styles.rounds}>
        {target !== null && (
          <>
            <Round
              icon="navigation-variant-outline"
              label="Navigate"
              testID="team-shape-navigate"
              onPress={() => {
                close();
                onNavigate(target[1], target[0]);
              }}
            />
            <Round
              icon="crosshairs-gps"
              label="Centre"
              testID="team-shape-centre"
              onPress={() => useTeamMapFocus.getState().focus(target[0], target[1], 16)}
            />
          </>
        )}
        {!mine && (
          <Round
            icon="message-text-outline"
            label="Message"
            testID="team-shape-message"
            onPress={() => {
              close();
              router.push('/team/chat');
            }}
          />
        )}
        {canDelete && (
          <Round
            icon="delete-outline"
            label="Delete"
            testID="team-shape-delete"
            onPress={() => {
              teamService()?.active?.draw.remove(shape.owner, shape.id);
              useTeamStore.getState().refresh();
              close();
            }}
          />
        )}
      </View>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 12,
    gap: 6,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4, minHeight: 56 },
  note: { paddingHorizontal: 6 },
  life: { height: 6, borderRadius: 3, marginHorizontal: 6, overflow: 'hidden' },
  lifeFill: { height: 6, borderRadius: 3 },
  lifeCap: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6 },
  rounds: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 4 },
});
