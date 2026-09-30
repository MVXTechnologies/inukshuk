import { GOALS, goalsView, type CostsDocument } from '@core/support/costs';
import {
  goalFundedLabel,
  percentFundedLabel,
  supportersLabel,
  supportPageUrl,
} from '@core/support/format';
import type { TipOffer } from '@core/support/tips';
import { HeaderAction } from '@ui/components/ScreenHeader';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSupportCosts } from './useSupportCosts';
import { useTipJar, type TipJar } from './useTipJar';

/**
 * Settings › Support Inukshuk (#476, board `Main.dc.html`): why the app is
 * free, what the year costs and how far along it is, the three tips, and
 * where the money goes. Nothing here unlocks anything.
 */

const STORE_NAME = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';

function deviceLocale(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return null;
  }
}

export function SupportScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const t = useSchemeTokens();
  const costs = useSupportCosts();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const fromJar = from === 'jar';
  const onThanks = useCallback(
    (tip: string) => router.replace({ pathname: '/support/thanks', params: { tip } }),
    [router],
  );
  const jar = useTipJar(onThanks);
  // Opened from the floating tip jar: go straight to "Leave a tip", and stay
  // there until the person scrolls. Re-applied whenever the heading moves (the
  // yearly figures load above it) or the content grows (the tiers arrive: a
  // scroll asked for while the page is still short is clamped by the view).
  const scrollRef = useRef<ScrollView>(null);
  const userScrolled = useRef(false);
  const tipsY = useRef<number | null>(null);
  const keepTipsInView = () => {
    if (!fromJar || userScrolled.current || tipsY.current === null) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, tipsY.current - space.md), animated: false });
  };
  const onTipsLayout = (y: number) => {
    tipsY.current = y;
    keepTipsInView();
  };

  return (
    <View style={[styles.fill, { backgroundColor: t.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <HeaderAction icon="arrow-left" onPress={() => router.back()} accessibilityLabel="Back" />
        <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
          Support Inukshuk
        </Text>
      </View>

      <ScrollView
        ref={scrollRef}
        onContentSizeChange={keepTipsInView}
        onScrollBeginDrag={() => {
          userScrolled.current = true;
        }}
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
      >
        <View
          style={[
            styles.card,
            styles.intro,
            { backgroundColor: t.surface, borderColor: t.outlineVariant },
          ]}
        >
          <Text style={[styles.introTitle, { color: t.ink }]}>
            Free for everyone. Kept alive by donations.
          </Text>
          <Text style={[styles.body, { color: t.inkMuted }]}>
            Inukshuk has no ads, no tracking and nothing to unlock. It is made by one person in
            Québec City and paid for by the people who use it. If it helped you find your way, a
            small tip keeps the maps and servers running for everyone.
          </Text>
        </View>

        {costs !== null && <YearProgress costs={costs} />}

        <View onLayout={(e) => onTipsLayout(e.nativeEvent.layout.y)} style={styles.tipsHeading}>
          <Text accessibilityRole="header" style={[styles.h2, { color: t.ink }]}>
            Leave a tip
          </Text>
          {fromJar && (
            <Text style={[styles.prompt, { color: t.inkMuted }]} testID="support-jar-prompt">
              Thanks for stopping by the tip jar. Any amount helps keep Inukshuk free for everyone.
            </Text>
          )}
        </View>
        <TipSection jar={jar} />
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push('/support/verify')}
          style={({ pressed }) => [styles.quietLink, pressed && styles.pressed]}
          hitSlop={8}
        >
          <Text style={[styles.quietLinkText, { color: t.inkMuted }]}>I already donated</Text>
        </Pressable>

        <WhatDonationsPayFor />

        <Pressable
          accessibilityRole="link"
          onPress={() =>
            void Linking.openURL(supportPageUrl(deviceLocale())).catch(() => undefined)
          }
          style={({ pressed }) => [styles.link, pressed && styles.pressed]}
          hitSlop={8}
        >
          <Text style={[styles.linkText, { color: t.support.link }]}>
            More about supporting Inukshuk on the website →
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

/**
 * This year's two goals, funded in order (owner rule: percentages only, never
 * an amount): the active goal's bar, and a small check for each goal already
 * funded.
 */
function YearProgress({ costs }: { costs: CostsDocument }) {
  const t = useSchemeTokens();
  if (costs.goals === null) return null;
  const { funded, active } = goalsView(costs.goals);
  const caption = [
    costs.supporters === null ? null : supportersLabel(costs.supporters),
    'updated monthly',
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
  return (
    <View style={styles.progress} testID="support-progress">
      <Text accessibilityRole="header" style={[styles.h2, { color: t.ink }]}>
        This year
      </Text>
      {funded.map((goal) => (
        <View key={goal.id} style={styles.fundedRow} testID={`goal-funded-${goal.id}`}>
          <Icon source="check-circle" size={18} color={t.support.progress} />
          <Text style={[styles.fundedText, { color: t.inkMuted }]}>
            {goalFundedLabel(goal.label, costs.year)}
          </Text>
        </View>
      ))}
      {active === null ? (
        <Text style={[styles.body, { color: t.ink }]} testID="goals-all-funded">
          Both goals are funded{costs.year === null ? '' : ` for ${costs.year}`}. Thank you!
        </Text>
      ) : (
        <>
          <View style={styles.progressHead}>
            <Text style={[styles.goalLabel, { color: t.ink }]}>{active.label}</Text>
            <Text style={[styles.progressLabel, { color: t.inkMuted }]}>
              {percentFundedLabel(active.percent)}
            </Text>
          </View>
          <View
            style={[styles.bar, { backgroundColor: t.support.progressTrack }]}
            accessible
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: active.percent }}
            accessibilityLabel={`${active.label}: ${active.percent} percent funded`}
          >
            <View
              style={[
                styles.barFill,
                { width: `${active.percent}%`, backgroundColor: t.support.progress },
              ]}
            />
          </View>
        </>
      )}
      <Text style={[styles.caption, { color: t.inkMuted }]}>{caption}</Text>
    </View>
  );
}

function TipSection({ jar }: { jar: TipJar }) {
  const t = useSchemeTokens();

  if (jar.phase === 'loading') {
    return (
      <View style={styles.tipsState}>
        <ActivityIndicator accessibilityLabel="Loading tips" />
      </View>
    );
  }

  if (jar.phase === 'unavailable') {
    return (
      <View
        style={[
          styles.card,
          styles.unavailable,
          { backgroundColor: t.surface, borderColor: t.outlineVariant },
        ]}
      >
        <Icon source="information-outline" size={22} color={t.inkMuted} />
        <Text style={[styles.body, styles.flex, { color: t.inkMuted }]}>
          {
            "Tips aren't available on this device right now. Everything in Inukshuk stays free either way."
          }
        </Text>
      </View>
    );
  }

  const chosen = jar.offers.find((o) => o.id === jar.selected) ?? null;
  return (
    <>
      <View style={styles.tiers} accessibilityRole="radiogroup">
        {jar.offers.map((offer) => (
          <TipTile
            key={offer.id}
            offer={offer}
            selected={offer.id === jar.selected}
            onPress={() => jar.select(offer.id)}
            disabled={jar.buying}
          />
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: jar.buying || chosen === null, busy: jar.buying }}
        disabled={jar.buying || chosen === null}
        onPress={jar.buy}
        style={({ pressed }) => [
          styles.tipButton,
          { backgroundColor: t.support.accent },
          (pressed || jar.buying) && styles.pressed,
        ]}
      >
        {jar.buying ? (
          <ActivityIndicator
            color={t.support.onAccent}
            accessibilityLabel="Waiting for the store"
          />
        ) : (
          <Text style={[styles.tipButtonLabel, { color: t.support.onAccent }]}>
            {chosen === null ? 'Tip' : `Tip ${chosen.displayPrice}`}
          </Text>
        )}
      </Pressable>
      {jar.notice !== null && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.notice, { color: t.ink }]}
          testID="support-notice"
        >
          {jar.notice}
        </Text>
      )}
      <Text style={[styles.footnote, { color: t.inkMuted }]}>
        Paid through {STORE_NAME}. A tip unlocks nothing: everything stays free.
      </Text>
    </>
  );
}

function TipTile({
  offer,
  selected,
  onPress,
  disabled,
}: {
  offer: TipOffer;
  selected: boolean;
  onPress: () => void;
  disabled: boolean;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected, disabled }}
      accessibilityLabel={`${offer.name}, ${offer.what}, ${offer.displayPrice}`}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.tile,
        {
          backgroundColor: selected ? t.support.selected : t.surface,
          borderColor: selected ? t.support.selectedBorder : t.outlineVariant,
        },
        pressed && styles.pressed,
      ]}
    >
      <Icon source={offer.icon} size={26} color={t.support.link} />
      <View style={styles.tileText}>
        <Text style={[styles.tileName, { color: t.ink }]}>{offer.name}</Text>
        <Text style={[styles.tileWhat, { color: t.inkMuted }]}>{offer.what}</Text>
      </View>
      <Text style={[styles.tilePrice, { color: t.ink }]}>{offer.displayPrice}</Text>
    </Pressable>
  );
}

/** What donations pay for, grouped under the two goals — plain words, no amounts. */
function WhatDonationsPayFor() {
  const t = useSchemeTokens();
  return (
    <>
      <Text accessibilityRole="header" style={[styles.h2, styles.moneyHeading, { color: t.ink }]}>
        What donations pay for
      </Text>
      <View
        style={[
          styles.card,
          styles.ledger,
          { backgroundColor: t.surface, borderColor: t.outlineVariant },
        ]}
        testID="donations-pay-for"
      >
        {GOALS.map((goal, gi) => (
          <View
            key={goal.id}
            style={[
              styles.ledgerGroup,
              gi < GOALS.length - 1 && {
                borderBottomColor: t.outlineVariant,
                borderBottomWidth: StyleSheet.hairlineWidth,
              },
            ]}
          >
            <Text style={[styles.ledgerGroupTitle, { color: t.ink }]}>{goal.label}</Text>
            {goal.payFor.map((line) => (
              <Text key={line} style={[styles.ledgerLabel, { color: t.inkMuted }]}>
                · {line}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.xs,
    paddingRight: space.sm,
    gap: space.xs,
  },
  title: { flex: 1, fontSize: 22, lineHeight: 28, fontWeight: '800' },
  card: { marginHorizontal: space.lg, borderRadius: 16, borderWidth: 1 },
  intro: { marginTop: space.md, padding: 18, gap: 10 },
  introTitle: { fontSize: 20, lineHeight: 25, fontWeight: '800' },
  body: { fontSize: 15, lineHeight: 22 },
  h2: { fontSize: 17, lineHeight: 22, fontWeight: '800' },
  progress: { marginTop: 20, marginHorizontal: space.lg, gap: space.sm },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  progressLabel: { fontSize: 14, fontWeight: '700' },
  bar: { height: 12, borderRadius: 6, overflow: 'hidden' },
  barFill: { height: 12, borderRadius: 6 },
  caption: { fontSize: 13, lineHeight: 18 },
  tipsHeading: { marginTop: space.xl, marginBottom: 10, marginHorizontal: space.lg, gap: 4 },
  prompt: { fontSize: 14, lineHeight: 20 },
  tipsState: { minHeight: 120, alignItems: 'center', justifyContent: 'center' },
  unavailable: {
    padding: space.lg,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  tiers: { paddingHorizontal: space.lg, gap: 10 },
  tile: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 10,
    paddingHorizontal: space.lg,
    borderRadius: 14,
    borderWidth: 2,
  },
  tileText: { flex: 1, gap: 2 },
  tileName: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  tileWhat: { fontSize: 13, lineHeight: 18 },
  tilePrice: { fontSize: 17, fontWeight: '800' },
  tipButton: {
    marginTop: 14,
    marginHorizontal: space.lg,
    minHeight: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tipButtonLabel: { fontSize: 17, fontWeight: '800' },
  notice: {
    marginTop: 10,
    marginHorizontal: space.lg,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  footnote: {
    marginTop: space.sm,
    marginHorizontal: space.lg,
    fontSize: 12.5,
    lineHeight: 17,
    textAlign: 'center',
  },
  moneyHeading: { marginTop: 26, marginBottom: space.sm, marginHorizontal: space.lg },
  ledger: { borderRadius: 14 },
  ledgerGroup: { paddingVertical: space.md, paddingHorizontal: 14, gap: 4 },
  ledgerGroupTitle: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  goalLabel: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  fundedRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fundedText: { fontSize: 14, lineHeight: 19, fontWeight: '700' },
  ledgerLabel: { fontSize: 14.5, lineHeight: 20 },
  link: {
    marginTop: 14,
    marginHorizontal: space.lg,
    minHeight: target.min,
    justifyContent: 'center',
  },
  linkText: { fontSize: 15, fontWeight: '700' },
  quietLink: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', marginTop: 4 },
  quietLinkText: { fontSize: 14, fontWeight: '700', textDecorationLine: 'underline' },
  pressed: { opacity: 0.75 },
});
