import { formatReport, runNativeSuite, type NativeSuiteReport } from '@core/convert/nativeSuite';
import type { Suite } from '@core/convert/suite';
import { fsPath, selfTestDir } from '@data/projGrids';
import { initNativeProj, nativeProjInfo, nativeSuiteEngine } from '@lib/nativeProj';
import { Directory, File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { keepAlive } from '@data/keepAlive';

/**
 * The on-device regression gate (CONVERT §5.5 step 3), reached only by
 * `scripts/convert-native-suite.sh`: it pushes the reference suite and the
 * PROJ-data grids into `Documents/convert-selftest/`, opens
 * `inukshuk://convert-selftest`, and pulls `result.txt` / `result.json`.
 * Without those files this screen does nothing (it ships in the app, inert).
 */
export function ConvertSelfTestScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('Convert self-test: starting…');

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const dir = selfTestDir();
      const ref = new File(dir, 'reference.json');
      if (!dir.exists || !ref.exists) {
        setText('Convert self-test: no test data on this device.');
        return;
      }
      const engine = nativeSuiteEngine();
      if (!engine) {
        setText('Convert self-test: RESULT: FAIL — the PROJ module is not in this build.');
        return;
      }
      const grids = new Directory(dir, 'grids');
      const info = initNativeProj([fsPath(grids.uri)]);
      const suite = JSON.parse(await keepAlive(ref, ref.text())) as Suite;
      const t0 = Date.now();
      const report: NativeSuiteReport = await runNativeSuite(engine, suite);
      const header = `Convert native suite — device (PROJ ${info?.projVersion ?? '?'}, EPSG ${info?.epsgVersion ?? '?'}) in ${Date.now() - t0} ms`;
      const out = formatReport(report, header);
      const tsv = report.pairs
        .map((p) =>
          [p.pair, p.n, p.pass, p.known, p.fail, p.skip, p.maxH ?? '', p.maxV ?? '', p.tool].join(
            '\t',
          ),
        )
        .join('\n');
      const checks = report.checks
        .map((c) => `${c.ok ? 'ok  ' : 'FAIL'}\t${c.kind}\t${c.id}\t${c.detail}`)
        .join('\n');
      for (const [name, body] of [
        [
          'result.txt',
          `${out}\n\npair\tn\tpass\tknown\tfail\tskip\tmaxH_m\tmaxV_m\ttool\n${tsv}\n\n${checks}\n`,
        ],
        [
          'result.json',
          JSON.stringify({
            header,
            totals: report.totals,
            ok: report.ok,
            pairs: report.pairs,
            checks: report.checks,
            failures: report.points.filter((p) => p.verdict === 'FAIL'),
          }),
        ],
      ] as const) {
        const f = new File(dir, name);
        if (f.exists) f.delete();
        f.create();
        f.write(body);
      }
      if (alive) setText(`${out}\n\n${nativeProjInfo()?.bundledGridDir ?? ''}`);
    };
    run().catch(
      (e: unknown) => alive && setText(`Convert self-test: RESULT: FAIL — ${(e as Error).message}`),
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      <Text
        variant="bodyMedium"
        selectable
        testID="convert-selftest-result"
        style={{ color: theme.colors.onBackground }}
      >
        {text}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16 },
});
