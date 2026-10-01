import {
  DONOR_NAME_MAX,
  DONOR_PLACE_MAX,
  donorSubmission,
  validateDonorForm,
} from '@core/support/donors';
import { submitDonorName, type DonorSubmitResult } from '@data/donorSubmit';
import { useSupportStore } from '@state/supportStore';
import { HeaderAction } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, HelperText, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * "Add your name to the donors list" (#476): a display name and an optional
 * place, sent only after an explicit consent line. The owner checks the
 * store transactions before anything is published.
 */

const FAILURE: Record<Exclude<DonorSubmitResult, 'sent'>, string> = {
  'rate-limited': 'Too many tries for now. Please try again in a few minutes.',
  rejected: 'That could not be sent. Please check the name and try again.',
  offline: "Couldn't reach our server. Check your connection and try again.",
};

export function DonorFormScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const t = useSchemeTokens();
  const [name, setName] = useState('');
  const [place, setPlace] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async () => {
    Keyboard.dismiss();
    const form = validateDonorForm(name, place);
    if (!form.ok) {
      setError(form.error);
      return;
    }
    setError(null);
    setSending(true);
    const ledger = useSupportStore.getState();
    const result = await submitDonorName(
      donorSubmission(form, Platform.OS === 'ios' ? 'ios' : 'android', ledger),
    );
    setSending(false);
    if (result === 'sent') {
      useSupportStore.getState().markDonorSubmitted();
      setSent(true);
    } else {
      setError(FAILURE[result]);
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: t.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <HeaderAction icon="arrow-left" onPress={() => router.back()} accessibilityLabel="Back" />
        <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
          Donors list
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {sent ? (
          <View style={styles.gap} testID="donor-sent">
            <Text style={[styles.lead, { color: t.ink }]}>Thank you. Your name is on its way.</Text>
            <Text style={[styles.text, { color: t.inkMuted }]}>
              It will appear in the app and on the website once the gift has been checked against
              the store reports, usually at the next monthly update.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.dismissTo('/')}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: t.support.accent },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.buttonLabel, { color: t.support.onAccent }]}>
                Back to the map
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.gap}>
            <Text style={[styles.text, { color: t.inkMuted }]}>
              Your tips add up to a gift that helps carry Inukshuk. If you like, your name can join
              the list of prominent donors. It is entirely optional.
            </Text>
            <TextInput
              mode="outlined"
              label="Name to show"
              value={name}
              onChangeText={setName}
              maxLength={DONOR_NAME_MAX}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
              accessibilityLabel="Name to show"
            />
            <TextInput
              mode="outlined"
              label="Town or region (optional)"
              value={place}
              onChangeText={setPlace}
              maxLength={DONOR_PLACE_MAX}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={() => Keyboard.dismiss()}
              accessibilityLabel="Town or region, optional"
            />
            <Text style={[styles.consent, { color: t.ink }]} testID="donor-consent">
              Your name will be shown publicly in the app and on the website.
            </Text>
            <Text style={[styles.small, { color: t.inkMuted }]}>
              We send only these two fields and your store receipt numbers, so the gift can be
              checked. No email, no account. To be removed later, write to
              marc-andre.vigneault@mvxtechnologies.com.
            </Text>
            {error !== null && (
              <HelperText type="error" visible accessibilityLiveRegion="polite">
                {error}
              </HelperText>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: sending, busy: sending }}
              disabled={sending}
              onPress={() => void onSubmit()}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: t.support.accent },
                (pressed || sending) && styles.pressed,
              ]}
            >
              {sending ? (
                <ActivityIndicator color={t.support.onAccent} accessibilityLabel="Sending" />
              ) : (
                <Text style={[styles.buttonLabel, { color: t.support.onAccent }]}>Add my name</Text>
              )}
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.xs,
    paddingRight: space.sm,
    gap: space.xs,
  },
  title: { flex: 1, fontSize: 22, lineHeight: 28, fontWeight: '800' },
  body: { paddingHorizontal: space.lg, paddingTop: space.md },
  gap: { gap: 14 },
  lead: { fontSize: 20, lineHeight: 26, fontWeight: '800' },
  text: { fontSize: 15, lineHeight: 22 },
  consent: { fontSize: 15, lineHeight: 22, fontWeight: '700' },
  small: { fontSize: 13, lineHeight: 18 },
  button: {
    marginTop: space.sm,
    minHeight: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 17, fontWeight: '800' },
  pressed: { opacity: 0.75 },
});
