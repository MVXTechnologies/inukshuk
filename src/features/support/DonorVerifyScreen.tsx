import {
  checkOutcome,
  normalizeCode,
  normalizeEmail,
  restUntil,
  verifyMessage,
} from '@core/support/verify';
import { checkDonorVerify, startDonorVerify } from '@data/donorVerify';
import { useSettingsStore } from '@state/settingsStore';
import { HeaderAction } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, HelperText, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * "I already donated" (#476, round 3). Honour system: an emailed code only
 * shows the person reads that inbox; nobody checks a donation. Success rests
 * the tip button for 12 months on this device (it comes back after).
 */

type Step = 'email' | 'code' | 'done';

const START_FAILURE = {
  'rate-limited': 'Too many codes asked for now. Please try again in an hour.',
  invalid: 'Please check the email address.',
  offline: "Couldn't reach our server. Check your connection and try again.",
} as const;

export function DonorVerifyScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const t = useSchemeTokens();
  const set = useSettingsStore((s) => s.set);
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentAt, setSentAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    Keyboard.dismiss();
    const normalized = normalizeEmail(email);
    if (normalized === null) {
      setError('Please check the email address.');
      return;
    }
    setError(null);
    setBusy(true);
    const result = await startDonorVerify(normalized);
    setBusy(false);
    if (result === 'sent') {
      setSentAt(Date.now());
      setCode('');
      setStep('code');
    } else {
      setError(START_FAILURE[result]);
    }
  };

  const confirm = async () => {
    Keyboard.dismiss();
    const normalizedEmail = normalizeEmail(email);
    const normalizedCode = normalizeCode(code);
    if (normalizedEmail === null || normalizedCode === null) {
      setError('The code has six digits.');
      return;
    }
    setError(null);
    setBusy(true);
    const result = await checkDonorVerify(normalizedEmail, normalizedCode);
    setBusy(false);
    const outcome = checkOutcome(result, sentAt, Date.now());
    if (outcome === 'verified') {
      set('tipJarRestingUntil', restUntil(Date.now()));
      setStep('done');
    } else {
      setError(verifyMessage(outcome));
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: t.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <HeaderAction icon="arrow-left" onPress={() => router.back()} accessibilityLabel="Back" />
        <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
          I already donated
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {step === 'email' && (
          <View style={styles.gap} testID="verify-email-step">
            <Text style={[styles.text, { color: t.inkMuted }]}>
              Thank you. If you gave on the web or another device, we can keep the tip button out of
              your way here for a year. We just send a code to your email, to make sure it is you.
            </Text>
            <TextInput
              mode="outlined"
              label="Email"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              returnKeyType="send"
              onSubmitEditing={() => void sendCode()}
              accessibilityLabel="Email"
            />
            <Text style={[styles.small, { color: t.inkMuted }]}>
              Your email is used only to send the code. It is not kept (the code expires in 15
              minutes) and never shared. We don&apos;t check any donation: it&apos;s on your honour.
            </Text>
            {error !== null && (
              <HelperText type="error" visible accessibilityLiveRegion="polite">
                {error}
              </HelperText>
            )}
            <PrimaryButton label="Send the code" busy={busy} onPress={() => void sendCode()} />
          </View>
        )}
        {step === 'code' && (
          <View style={styles.gap} testID="verify-code-step">
            <Text style={[styles.text, { color: t.inkMuted }]}>
              We sent a 6-digit code to {normalizeEmail(email) ?? email}. It expires in 15 minutes.
            </Text>
            <TextInput
              mode="outlined"
              label="Code"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              maxLength={7}
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              returnKeyType="done"
              onSubmitEditing={() => void confirm()}
              accessibilityLabel="Code"
            />
            {error !== null && (
              <HelperText type="error" visible accessibilityLiveRegion="polite">
                {error}
              </HelperText>
            )}
            <PrimaryButton label="Confirm" busy={busy} onPress={() => void confirm()} />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setError(null);
                setStep('email');
              }}
              style={styles.link}
              hitSlop={8}
            >
              <Text style={[styles.linkText, { color: t.support.link }]}>
                Use another email or send a new code
              </Text>
            </Pressable>
          </View>
        )}
        {step === 'done' && (
          <View style={styles.gap} testID="verify-done">
            <Text style={[styles.lead, { color: t.ink }]}>Thank you for your gift.</Text>
            <Text style={[styles.text, { color: t.inkMuted }]}>
              The tip button will stay out of your way on this device for a year.
            </Text>
            <PrimaryButton
              label="Back to the map"
              busy={false}
              onPress={() => router.dismissTo('/')}
            />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function PrimaryButton({
  label,
  busy,
  onPress,
}: {
  label: string;
  busy: boolean;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: t.support.accent },
        (pressed || busy) && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={t.support.onAccent} accessibilityLabel="Please wait" />
      ) : (
        <Text style={[styles.buttonLabel, { color: t.support.onAccent }]}>{label}</Text>
      )}
    </Pressable>
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
  small: { fontSize: 13, lineHeight: 18 },
  button: {
    marginTop: space.sm,
    minHeight: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 17, fontWeight: '800' },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.75 },
});
