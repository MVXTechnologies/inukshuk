import { useGnssStore } from '@state/gnssStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { ExtensionSettingsShell } from '../ExtensionSettingsShell';
import { useExtensionPrefs } from '../prefs';
import {
  GnssCorrectionsOption,
  GnssDatumOption,
  GnssFallbackOption,
  GnssReceiverOption,
  GnssStandbyOption,
} from './options';

/**
 * External GNSS receiver in Settings → Extensions (mockup `gnss-settings`):
 * Get / switch / Remove through the shared frame; once installed, the
 * receiver, RTK corrections, the project datum and the phone-GPS policy.
 */
export function GnssSettings() {
  const t = useSchemeTokens();
  const { installedAt } = useExtensionPrefs('gnss');
  const hydrated = useGnssStore((s) => s.hydrated);
  const error = useGnssStore((s) => s.error);

  useEffect(() => {
    if (installedAt > 0 && !hydrated) void useGnssStore.getState().hydrate();
  }, [installedAt, hydrated]);

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
      <GnssReceiverOption variant="settings" />
      <GnssCorrectionsOption variant="settings" />
      <GnssDatumOption variant="settings" />
      <GnssFallbackOption variant="settings" />
      <GnssStandbyOption variant="settings" />
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
