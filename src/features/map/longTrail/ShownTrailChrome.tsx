import type { Units } from '@core/format';
import type { LngLat } from '@core/models';
import { formatClimb, formatDistanceFrom, formatTrailLength } from '@core/trails/format';
import { distanceToLineM, toBoundingBox } from '@core/trails/geometry';
import { focusBbox, focusGeometry, stageTitle, stepStage } from '@core/trails/stages';
import { useTrailClimb } from '@features/store/trails/useTrailClimb';
import { exploreTrailHref } from '@features/store/explore/exploreRoutes';
import { useLongTrailsStore, type ShownTrail } from '@state/longTrailsStore';
import { useMapStore } from '@state/mapStore';
import { radius, space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

/**
 * The chrome of a long-distance trail shown on the main map (#467, board
 * `OnMap.dc.html`): a top pill with the trail's name and a close, and a
 * bottom sheet with the selected stage (number, name, length, climb, how far
 * you are from it), stage stepping, **Zoom to stage** and **Trail page**.
 *
 * There is no route-following mode in the app yet, so the board's "Follow
 * this stage" frames the stage instead — and says so.
 *
 * Plain themed Views: never a paper Surface (the absolutely-positioned iOS
 * flex collapse) nor a Portal.
 */

export function ShownTrailPill({ shown }: { shown: ShownTrail }) {
  const t = useSchemeTokens();
  const hide = useLongTrailsStore((s) => s.hide);
  return (
    <View style={[styles.pill, { backgroundColor: t.map.chrome }]}>
      <Icon source="map-marker-path" size={20} color={t.map.chromeInk} />
      <Text numberOfLines={1} style={[styles.pillText, { color: t.map.chromeInk }]}>
        {shown.detail.name}
      </Text>
      <Pressable
        onPress={hide}
        accessibilityRole="button"
        accessibilityLabel="Hide trail"
        hitSlop={4}
        style={styles.pillClose}
      >
        <Icon source="close" size={20} color={t.map.chromeInk} />
      </Pressable>
    </View>
  );
}

function youLine(position: LngLat | null, geometry: LngLat[][], units: Units): string | null {
  if (position === null) return null;
  const d = distanceToLineM(position, geometry);
  if (!Number.isFinite(d)) return null;
  if (d < 100) return 'you are on it';
  return `you are ${formatDistanceFrom(d, units)} from it`;
}

export function ShownTrailSheet({
  shown,
  position,
  units,
  onLayout,
}: {
  shown: ShownTrail;
  position: LngLat | null;
  units: Units;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  const setStage = useLongTrailsStore((s) => s.setStage);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const { detail, stageIndex } = shown;
  const climb = useTrailClimb(detail);
  const stage = stageIndex === null ? undefined : detail.stages[stageIndex];

  const title =
    stage !== undefined && stageIndex !== null
      ? stageTitle(stage, stageIndex, detail.name)
      : detail.name;
  const lengthKm = stage !== undefined ? stage.lengthKm : detail.lengthKm;
  const climbM =
    climb.status !== 'done'
      ? null
      : stageIndex === null
        ? climb.totalM
        : (climb.stagesM[stageIndex] ?? null);
  const meta = [
    lengthKm > 0 ? formatTrailLength(lengthKm, units) : null,
    climbM !== null ? `${formatClimb(climbM, units)} climb` : null,
    youLine(position, focusGeometry(detail, stageIndex), units),
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');

  const focus = (index: number | null) => setFocusBounds(toBoundingBox(focusBbox(detail, index)));
  const step = (delta: number) => {
    const next = stepStage(detail, stageIndex, delta);
    if (next === null || next === stageIndex) return;
    setStage(next);
    focus(next);
  };
  const stages = detail.stages.length;

  return (
    <View
      onLayout={onLayout}
      style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.outlineVariant }]}
    >
      <View style={[styles.handle, { backgroundColor: t.outlineVariant }]} />
      <View style={styles.headRow}>
        <View style={[styles.badge, { backgroundColor: t.explore.trailBadge }]}>
          {stageIndex !== null ? (
            <Text style={[styles.badgeText, { color: t.explore.trailBadgeInk }]}>
              {stageIndex + 1}
            </Text>
          ) : (
            <Icon source="map-marker-path" size={18} color={t.explore.trailBadgeInk} />
          )}
        </View>
        <View style={styles.headText}>
          <Text numberOfLines={2} style={[styles.title, { color: t.ink }]}>
            {title}
          </Text>
          {meta !== '' && <Text style={[styles.meta, { color: t.inkMuted }]}>{meta}</Text>}
        </View>
        {stages > 1 && stageIndex !== null && (
          <View style={styles.stepper}>
            <Pressable
              onPress={() => step(-1)}
              disabled={stageIndex === 0}
              accessibilityRole="button"
              accessibilityLabel="Previous stage"
              style={[styles.stepButton, stageIndex === 0 && styles.dim]}
            >
              <Icon source="chevron-left" size={24} color={t.ink} />
            </Pressable>
            <Pressable
              onPress={() => step(1)}
              disabled={stageIndex === stages - 1}
              accessibilityRole="button"
              accessibilityLabel="Next stage"
              style={[styles.stepButton, stageIndex === stages - 1 && styles.dim]}
            >
              <Icon source="chevron-right" size={24} color={t.ink} />
            </Pressable>
          </View>
        )}
      </View>
      <View style={styles.buttons}>
        <Pressable
          onPress={() => focus(stageIndex)}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: t.explore.accent },
            pressed && styles.dim,
          ]}
        >
          <Text style={[styles.primaryText, { color: t.background }]}>
            {stageIndex !== null ? 'Zoom to stage' : 'Zoom to trail'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => router.push(exploreTrailHref(detail.id))}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.secondary,
            { borderColor: t.explore.accent },
            pressed && styles.dim,
          ]}
        >
          <Text style={[styles.secondaryText, { color: t.explore.accent }]}>Trail page</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 48,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 16,
    paddingRight: 4,
  },
  pillText: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  pillClose: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: 10,
    zIndex: 4,
  },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  badge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  meta: { fontSize: 13, lineHeight: 18 },
  stepper: { flexDirection: 'row' },
  stepButton: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.4 },
  buttons: { flexDirection: 'row', gap: space.sm },
  primary: {
    flex: 1,
    minHeight: 46,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  secondary: {
    flex: 1,
    minHeight: 46,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
});
