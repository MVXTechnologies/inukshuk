import { annualTotal, progressFraction, type CostsDocument } from '@core/support/costs';
import {
  annualCostLabel,
  formatMoney,
  raisedOfGoalLabel,
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
  // there if the yearly figures load above it, until the person scrolls.
  const scrollRef = useRef<ScrollView>(null);
  const userScrolled = useRef(false);
  const onTipsLayout = (y: number) => {
    if (!fromJar || userScrolled.current) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - space.md), animated: false });
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

        {costs !== null && costs.costs.length > 0 && <MoneyGoes costs={costs} />}

        <Pressable
          accessibilityRole="link"
          onPress={() =>
            void Linking.openURL(supportPageUrl(deviceLocale())).catch(() => undefined)
          }
          style={({ pressed }) => [styles.link, pressed && styles.pressed]}
          hitSlop={8}
        >
          <Text style={[styles.linkText, { color: t.support.link }]}>
            See the full accounts on the website →
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function YearProgress({ costs }: { costs: CostsDocument }) {
  const t = useSchemeTokens();
  const pct = Math.round(progressFraction(costs.raised, costs.goal) * 100);
  return (
    <View style={styles.progress} testID="support-progress">
      <View style={styles.progressHead}>
        <Text accessibilityRole="header" style={[styles.h2, { color: t.ink }]}>
          This year
        </Text>
        <Text style={[styles.progressLabel, { color: t.inkMuted }]}>
          {raisedOfGoalLabel(costs.raised, costs.goal, costs.currency)}
        </Text>
      </View>
      <View
        style={[styles.bar, { backgroundColor: t.support.progressTrack }]}
        accessible
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: pct }}
        accessibilityLabel={`${pct} percent of this year's costs raised`}
      >
        <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: t.support.progress }]} />
      </View>
      <Text style={[styles.caption, { color: t.inkMuted }]}>
        {supportersLabel(costs.supporters)} · updated monthly
      </Text>
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

function MoneyGoes({ costs }: { costs: CostsDocument }) {
  const t = useSchemeTokens();
  return (
    <>
      <Text accessibilityRole="header" style={[styles.h2, styles.moneyHeading, { color: t.ink }]}>
        Where the money goes
      </Text>
      <View
        style={[
          styles.card,
          styles.ledger,
          { backgroundColor: t.surface, borderColor: t.outlineVariant },
        ]}
      >
        {costs.costs.map((item, i) => (
          <View
            key={`${item.labelEn}-${i}`}
            style={[styles.ledgerRow, { borderBottomColor: t.outlineVariant }]}
          >
            <Text style={[styles.ledgerLabel, { color: t.ink }]}>{item.labelEn}</Text>
            <Text style={[styles.ledgerAmount, { color: t.ink }]}>
              {annualCostLabel(item, costs.currency)}
            </Text>
          </View>
        ))}
        <View style={[styles.ledgerRow, styles.ledgerTotal]}>
          <Text style={[styles.ledgerTotalText, { color: t.ink }]}>Total per year</Text>
          <Text style={[styles.ledgerTotalText, { color: t.ink }]}>
            {formatMoney(annualTotal(costs.costs), costs.currency)}
          </Text>
        </View>
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
  ledgerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ledgerLabel: { flex: 1, fontSize: 14.5, lineHeight: 20 },
  ledgerAmount: { fontSize: 14.5, lineHeight: 20, fontWeight: '700' },
  ledgerTotal: { borderBottomWidth: 0 },
  ledgerTotalText: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  link: {
    marginTop: 14,
    marginHorizontal: space.lg,
    minHeight: target.min,
    justifyContent: 'center',
  },
  linkText: { fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.75 },
});
