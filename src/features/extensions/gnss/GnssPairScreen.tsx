import type { LinkDevice } from '@data/gnss/link';
import { gnssSession } from '@features/gnss/session';
import { useGnssStore } from '@state/gnssStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Icon, Text } from 'react-native-paper';

import { GnssScreenFrame, SectionLabel } from './GnssScreenFrame';

/** Signal strength in four bars (RSSI dBm). */
export function signalBars(rssi: number | null): number {
  if (rssi === null) return 0;
  if (rssi >= -60) return 4;
  if (rssi >= -70) return 3;
  if (rssi >= -80) return 2;
  return 1;
}

function Bars({ rssi }: { rssi: number | null }) {
  const t = useSchemeTokens();
  const n = signalBars(rssi);
  if (rssi === null) return null;
  return (
    <View style={styles.bars} accessibilityLabel={`Signal ${n} of 4`}>
      {[1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={[
            styles.bar,
            { height: 4 + i * 3, backgroundColor: i <= n ? t.ink : t.outlineVariant },
          ]}
        />
      ))}
    </View>
  );
}

const TRANSPORT: Record<LinkDevice['transport'], string> = {
  ble: 'Bluetooth LE',
  spp: 'Bluetooth Classic',
  fake: 'Replays a recorded RTK session · for demos and tests',
};

function DeviceRow({ d, onConnect }: { d: LinkDevice; onConnect: () => void }) {
  const t = useSchemeTokens();
  const name = d.name ?? 'Unnamed receiver';
  return (
    <View style={styles.device}>
      <View style={[styles.badge, { backgroundColor: t.surfaceVariant }]}>
        <Icon
          source={d.transport === 'fake' ? 'play-circle-outline' : 'satellite-variant'}
          size={22}
          color={t.ink}
        />
      </View>
      <View style={styles.flex}>
        <Text variant="titleSmall" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={2}>
          {TRANSPORT[d.transport]}
        </Text>
      </View>
      <Bars rssi={d.rssi} />
      <Button mode="outlined" compact onPress={onConnect} accessibilityLabel={`Connect ${name}`}>
        Connect
      </Button>
    </View>
  );
}

/**
 * Settings › External GNSS receiver › Receiver (mockup `gnss-pair`): the
 * paired receiver (and Forget), then the receivers a scan finds — Bluetooth
 * LE nearby, Bluetooth Classic already paired with the phone (Android), and
 * the simulated receiver in debug / E2E builds.
 */
export function GnssPairScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const scanning = useGnssStore((s) => s.scanning);
  const devices = useGnssStore((s) => s.devices);
  const receiver = useGnssStore((s) => s.config.receiver);
  const link = useGnssStore((s) => s.link);
  const error = useGnssStore((s) => s.error);
  const permissionBlocked = useGnssStore((s) => s.permissionBlocked);
  const update = useGnssStore((s) => s.updateConfig);

  useEffect(() => {
    const session = gnssSession();
    void useGnssStore
      .getState()
      .hydrate()
      .then(() => session?.scan());
    return () => session?.stopScan();
  }, []);

  const connect = (d: LinkDevice) => {
    gnssSession()?.stopScan();
    update({
      receiver: { id: d.id, name: d.name ?? 'Receiver', transport: d.transport },
    });
    router.back();
  };

  const others = devices.filter((d) => d.id !== receiver?.id);
  const ble = others.filter((d) => d.transport === 'ble');
  const classic = others.filter((d) => d.transport === 'spp');
  const fake = others.filter((d) => d.transport === 'fake');

  return (
    <GnssScreenFrame title="Connect a receiver" testID="gnss-pair-screen">
      {receiver !== null && (
        <View style={[styles.current, { backgroundColor: t.surfaceVariant }]}>
          <Icon source="satellite-variant" size={22} color={t.ink} />
          <View style={styles.flex}>
            <Text variant="titleSmall">{receiver.name}</Text>
            <Text variant="bodySmall" style={{ color: t.inkVariant }}>
              {link === 'connected'
                ? 'Connected'
                : link === 'connecting'
                  ? 'Connecting…'
                  : 'Paired'}
            </Text>
          </View>
          <Button
            mode="text"
            onPress={() => update({ receiver: null })}
            accessibilityLabel={`Forget ${receiver.name}`}
          >
            Forget
          </Button>
        </View>
      )}

      <View style={styles.scanRow}>
        {scanning ? (
          <ActivityIndicator size={16} />
        ) : (
          <Icon source="bluetooth" size={18} color={t.inkVariant} />
        )}
        <Text variant="bodyMedium" style={[styles.flex, { color: t.inkVariant }]}>
          {scanning ? 'Looking for receivers… keep yours on and close by' : 'Scan finished'}
        </Text>
        {!scanning && (
          <Button compact onPress={() => void gnssSession()?.scan()}>
            Scan again
          </Button>
        )}
      </View>

      {error !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {error}
        </Text>
      )}
      {permissionBlocked && (
        <Button
          mode="outlined"
          icon="cog-outline"
          style={styles.settingsButton}
          onPress={() => void Linking.openSettings()}
        >
          Open settings
        </Button>
      )}

      {ble.length > 0 && <SectionLabel>Nearby · Bluetooth LE</SectionLabel>}
      {ble.map((d) => (
        <DeviceRow key={d.id} d={d} onConnect={() => connect(d)} />
      ))}
      {classic.length > 0 && <SectionLabel>Paired · Bluetooth Classic</SectionLabel>}
      {classic.map((d) => (
        <DeviceRow key={d.id} d={d} onConnect={() => connect(d)} />
      ))}
      {fake.length > 0 && <SectionLabel>Simulated</SectionLabel>}
      {fake.map((d) => (
        <DeviceRow key={d.id} d={d} onConnect={() => connect(d)} />
      ))}
      {!scanning && others.length === 0 && (
        <Text variant="bodyMedium" style={{ color: t.inkVariant }}>
          No receiver found. Is it on, charged and not connected to another phone?
        </Text>
      )}

      <Text variant="bodySmall" style={[styles.note, { color: t.inkMuted }]}>
        {Platform.OS === 'android'
          ? 'Not listed? Bluetooth Classic receivers (Bad Elf, Garmin GLO, Emlid Reach) must be paired in Android’s Bluetooth settings first.'
          : 'Bluetooth Classic receivers made for iPhone (Bad Elf, Garmin GLO) work through iOS itself: once paired in the iPhone’s settings, the phone’s location already uses them.'}
      </Text>
    </GnssScreenFrame>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  current: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16 },
  scanRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  device: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 16 },
  bar: { width: 4, borderRadius: 1 },
  note: { marginTop: 8 },
  settingsButton: { alignSelf: 'flex-start' },
});
