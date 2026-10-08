/** The camera half of the invite scanner (load it through `./QrScanner`). */
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

import type { QrScannerProps } from './QrScanner';

export function QrScannerView({ onCode, onClose }: QrScannerProps) {
  const t = useSchemeTokens();
  const [permission, request] = useCameraPermissions();
  const last = useRef<string | null>(null);

  if (permission === null)
    return <View style={[styles.box, { backgroundColor: t.team.scannerBackdrop }]} />;
  if (!permission.granted) {
    return (
      <View style={[styles.box, styles.center, { backgroundColor: t.surfaceVariant }]}>
        <Text variant="bodyMedium" style={[styles.text, { color: t.ink }]}>
          Inukshuk needs the camera to read the invite code.
        </Text>
        {permission.canAskAgain ? (
          <Button mode="contained" onPress={() => void request()}>
            Allow camera
          </Button>
        ) : (
          <Button mode="contained" onPress={() => void Linking.openSettings()}>
            Open Settings
          </Button>
        )}
        <Button mode="text" onPress={onClose}>
          Cancel
        </Button>
      </View>
    );
  }
  return (
    <View
      style={[styles.box, { backgroundColor: t.team.scannerBackdrop }]}
      testID="team-qr-scanner"
    >
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (typeof data !== 'string' || data === last.current) return;
          last.current = data;
          onCode(data);
        }}
      />
      <View style={[styles.frame, { borderColor: t.team.scannerFrame }]} pointerEvents="none" />
      <Button mode="contained-tonal" onPress={onClose} style={styles.close}>
        Cancel
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { height: 360, borderRadius: 16, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  text: { textAlign: 'center' },
  frame: {
    position: 'absolute',
    left: '15%',
    right: '15%',
    top: '15%',
    bottom: '22%',
    borderWidth: 3,
    borderRadius: 18,
    opacity: 0.85,
  },
  close: { position: 'absolute', bottom: 12, alignSelf: 'center' },
});
