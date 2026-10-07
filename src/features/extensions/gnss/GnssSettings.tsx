import { stateLabel } from '@core/gnss/chip';
import { activeProfile } from '@core/gnss/config';
import { projectDatumOption } from '@core/gnss/projectDatum';
import { useGnssStore, type NtripState } from '@state/gnssStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, List, Switch, Text } from 'react-native-paper';

import { ExtensionSettingsShell } from '../ExtensionSettingsShell';
import { useExtensionPrefs } from '../prefs';

function linkLine(link: string, state: string | null): string {
  switch (link) {
    case 'connected':
      return state ? `connected · ${state}` : 'connected';
    case 'connecting':
      return 'connecting…';
    case 'reconnecting':
      return 'reconnecting…';
    default:
      return 'not connected';
  }
}

export function ntripLine(ntrip: NtripState): string {
  switch (ntrip.phase) {
    case 'streaming':
      return 'streaming';
    case 'connecting':
      return 'connecting…';
    case 'error':
    case 'unavailable':
      return ntrip.message ?? 'not connected';
    default:
      return 'starts with the receiver';
  }
}

/**
 * External GNSS receiver in Settings → Extensions (mockup `gnss-settings`):
 * Get / switch / Remove through the shared frame; once installed, the
 * receiver, RTK corrections, the project datum and the phone-GPS policy.
 */
export function GnssSettings() {
  const t = useSchemeTokens();
  const router = useRouter();
  const { installedAt } = useExtensionPrefs('gnss');
  const hydrated = useGnssStore((s) => s.hydrated);
  const config = useGnssStore((s) => s.config);
  const update = useGnssStore((s) => s.updateConfig);
  const link = useGnssStore((s) => s.link);
  const status = useGnssStore((s) => s.status);
  const ntrip = useGnssStore((s) => s.ntrip);
  const error = useGnssStore((s) => s.error);

  useEffect(() => {
    if (installedAt > 0 && !hydrated) void useGnssStore.getState().hydrate();
  }, [installedAt, hydrated]);

  const profile = activeProfile(config);
  const receiver = config.receiver;
  const state = status && status.state !== 'no-fix' ? stateLabel(status.state) : null;

  return (
    <ExtensionSettingsShell
      extKey="gnss"
      badge={undefined}
      badgeIcon="satellite-variant"
      badgeIconSize={22}
      description="A Bluetooth GNSS receiver for your location and recordings — from sub-metre GPS to centimetre RTK"
      legend={
        <Text variant="bodySmall" style={{ color: t.inkVariant }}>
          u-blox kits (ArduSimple, SparkFun), Bad Elf, Garmin GLO, Emlid Reach and other receivers
          that stream NMEA. RTK corrections from any NTRIP caster.
        </Text>
      }
      note="Free · works offline · corrections need mobile data and a caster account"
      showLabel="Use the external receiver"
      switchDescription={(on) =>
        on
          ? 'On · your location uses it while its fix is good'
          : 'Off · your location uses the phone GPS'
      }
      removeDescription="Forgets the receiver and the caster passwords"
      removeMessage="The receiver is disconnected and forgotten, and the caster passwords are deleted. Your correction profiles and project datum are kept."
    >
      {error !== null && (
        <View style={[styles.error, { backgroundColor: t.surfaceVariant }]}>
          <Icon source="alert-circle-outline" size={18} color={t.status.gpsLostInk} />
          <Text variant="bodySmall" style={[styles.flex, { color: t.ink }]}>
            {error}
          </Text>
        </View>
      )}
      <List.Item
        title="Receiver"
        description={
          receiver ? `${receiver.name} · ${linkLine(link, state)}` : 'None yet — connect one'
        }
        onPress={() => router.push('/gnss/pair')}
        right={(p) => <List.Icon {...p} icon="chevron-right" />}
        testID="gnss-receiver-row"
      />
      <List.Item
        title="RTK corrections (NTRIP)"
        description={
          profile
            ? `${profile.label}${profile.mountpoint ? ` · ${profile.mountpoint}` : ''} · ${ntripLine(ntrip)}`
            : 'Off · add a caster for centimetre RTK'
        }
        descriptionNumberOfLines={3}
        onPress={() => router.push('/gnss/corrections')}
        right={(p) => <List.Icon {...p} icon="chevron-right" />}
        testID="gnss-corrections-row"
      />
      <List.Item
        title="Project datum"
        description={`${projectDatumOption(config.projectDatumId).label} · coordinates in the receiver sheet`}
        descriptionNumberOfLines={2}
        onPress={() => router.push('/gnss/datum')}
        right={(p) => <List.Icon {...p} icon="chevron-right" />}
        testID="gnss-datum-row"
      />
      <List.Item
        title="Use the phone GPS when the receiver drops"
        titleNumberOfLines={2}
        description="The chip says which one you’re on"
        right={() => (
          <Switch
            value={config.fallbackToPhone}
            onValueChange={(v) => update({ fallbackToPhone: v })}
            accessibilityLabel="Use the phone GPS when the receiver drops"
          />
        )}
      />
      <List.Item
        title="Phone GPS in standby"
        description={
          config.phoneWhileGood === 'standby'
            ? 'Low power while the receiver is good, for an instant fallback'
            : 'Off while the receiver is good: saves battery, slower fallback'
        }
        descriptionNumberOfLines={2}
        right={() => (
          <Switch
            value={config.phoneWhileGood === 'standby'}
            onValueChange={(v) => update({ phoneWhileGood: v ? 'standby' : 'off' })}
            accessibilityLabel="Phone GPS in standby"
          />
        )}
      />
      <View style={[styles.info, { backgroundColor: t.surfaceVariant }]}>
        <Icon source="information-outline" size={18} color={t.inkVariant} />
        <Text variant="bodySmall" style={[styles.flex, { color: t.inkVariant }]}>
          Inukshuk uses the receiver for the blue dot and your recordings. Recorded points keep
          their source and the receiver’s accuracy; coordinates are shown with how they were
          converted and how accurate that is.
        </Text>
      </View>
    </ExtensionSettingsShell>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  info: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginVertical: 8,
    padding: 12,
    borderRadius: 12,
  },
  error: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    marginHorizontal: 16,
    marginVertical: 4,
    padding: 12,
    borderRadius: 12,
  },
});
