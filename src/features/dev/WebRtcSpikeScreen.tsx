import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet } from 'react-native';
import { Button, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  formatSpikeReport,
  runDataChannelLoopback,
  type SpikeStep,
  type WebRtcModuleLike,
} from './webrtcLoopback';

/**
 * react-native-webrtc, loaded on demand: importing it constructs the native
 * module (and its PeerConnectionFactory). `__DEV__` is false in release
 * bundles, so Metro drops the require there and the spike has nothing to run.
 */
function loadWebRtc(): WebRtcModuleLike | null {
  if (!__DEV__) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('react-native-webrtc') as WebRtcModuleLike;
}

/**
 * G4 go/no-go spike (2.7.0 live sync), debug builds only: open
 * `inukshuk://dev/webrtc-spike`. Two in-process RTCPeerConnections, a data
 * channel loopback (text, 64 KiB binary, 4 MiB throughput), and the R-RTC-2
 * DTLS fingerprint check through getStats(). The last line reads
 * `RESULT: PASS` or `RESULT: FAIL`; the same text goes to the JS log.
 */
export function WebRtcSpikeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [steps, setSteps] = useState<SpikeStep[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const running = useRef(false);
  const alive = useRef(true);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const header = `WebRTC spike — ${Platform.OS} ${String(Platform.Version)}`;
    try {
      const rtc = loadWebRtc();
      if (!rtc) {
        if (alive.current) setResult('RESULT: FAIL — debug builds only');
        return;
      }
      const report = await runDataChannelLoopback(rtc, {
        onStep: (s) => alive.current && setSteps((prev) => [...prev, s]),
      });
      const text = formatSpikeReport(report, header);
      console.log(text);
      if (alive.current) setResult(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    } catch (e) {
      // Loading the module itself failed (not linked, or the interop layer refused it).
      const text = `${header}\nRESULT: FAIL — ${(e as Error).message}`;
      console.log(text);
      if (alive.current) setResult(`RESULT: FAIL — ${(e as Error).message}`);
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // After the first paint: loading the module builds the native factory.
    const timer = setTimeout(() => void run(), 0);
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [run]);

  const rerun = () => {
    if (running.current) return;
    setSteps([]);
    setResult(null);
    void run();
  };

  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      <Text variant="titleMedium" style={{ color: theme.colors.onBackground }}>
        WebRTC data channel spike
      </Text>
      {steps.map((s) => (
        <Text
          key={s.name}
          variant="bodyMedium"
          selectable
          style={{ color: s.ok ? theme.colors.onBackground : theme.colors.error }}
        >
          {`${s.ok ? 'ok' : 'FAIL'} · ${s.name} (${s.ms} ms)\n${s.detail}`}
        </Text>
      ))}
      <Text
        variant="titleSmall"
        selectable
        testID="webrtc-spike-result"
        style={{ color: theme.colors.onBackground }}
      >
        {result ?? 'Running…'}
      </Text>
      <Button mode="outlined" onPress={rerun} disabled={result === null}>
        Run again
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
});
