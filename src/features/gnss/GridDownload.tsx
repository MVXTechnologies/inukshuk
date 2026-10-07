import { gridByFile } from '@core/convert/grids';
import { formatBytes, packsForGrids, type Pack } from '@core/convert/packs';
import { installPack, packIndex } from '@data/projGrids';
import { useConvertStore } from '@state/convertStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, ProgressBar, Text } from 'react-native-paper';

/** A grid's readable name ("CGG2013a (CGVD2013)"), else its file name. */
export function gridLabel(file: string): string {
  return gridByFile(file)?.label ?? file;
}

type DownloadState =
  | { phase: 'loading' }
  | { phase: 'ready'; packs: Pack[]; unavailable: string[] }
  | { phase: 'offline' }
  | { phase: 'downloading'; done: number; total: number }
  | { phase: 'error'; message: string };

/**
 * The packs that bring `grids` to this device at (lon, lat) — Convert's own
 * proj-grids packs, index and checksums (`@data/projGrids`) — and their
 * download. Installing bumps `gridsVersion`, so the receiver session (and
 * Convert) re-run the conversion that was waiting.
 */
export function useGridDownload(grids: readonly string[], lon: number, lat: number) {
  const [state, setState] = useState<DownloadState>({ phase: 'loading' });
  const key = grids.join(',');
  // Packs are regional: re-resolve when the fix moves ~10 km.
  const cell = `${Math.round(lon * 10)}|${Math.round(lat * 10)}`;

  useEffect(() => {
    if (key === '') return;
    let alive = true;
    packIndex({ network: true })
      .then((index) => {
        if (!alive) return;
        if (index === null) {
          setState({ phase: 'offline' });
          return;
        }
        const { packs, unavailable } = packsForGrids(index, key.split(','), lon, lat);
        setState({ phase: 'ready', packs, unavailable });
      })
      .catch(() => alive && setState({ phase: 'offline' }));
    return () => {
      alive = false;
    };
    // lon/lat are read through `cell` (a 0.1° step), not every epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cell]);

  const download = async (packs: Pack[]) => {
    const total = packs.reduce((n, p) => n + p.bytes, 0);
    let before = 0;
    setState({ phase: 'downloading', done: 0, total });
    try {
      for (const p of packs) {
        await installPack(p, (done) =>
          setState({ phase: 'downloading', done: before + done, total }),
        );
        before += p.bytes;
      }
      useConvertStore.getState().gridsChanged();
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return { state, download };
}

/**
 * "Needs a download" (amber, not the red of a refused route): the grid(s) a
 * validated conversion is waiting for, and a one-tap download with progress.
 */
export function GridDownload({
  grids,
  lon,
  lat,
  testID,
}: {
  grids: readonly string[];
  lon: number;
  lat: number;
  testID?: string;
}) {
  const t = useSchemeTokens();
  const { state, download } = useGridDownload(grids, lon, lat);
  const names = grids.map(gridLabel).join(', ');
  return (
    <View style={styles.box} testID={testID}>
      <View style={styles.row}>
        <Icon source="download-circle-outline" size={16} color={t.status.gpsWeak} />
        <Text style={[styles.text, { color: t.status.gpsWeak }]}>
          Needs the {names} grid on this device
        </Text>
      </View>
      {state.phase === 'loading' && (
        <Text style={[styles.small, { color: t.inkMuted }]}>Looking up the download…</Text>
      )}
      {state.phase === 'offline' && (
        <Text style={[styles.small, { color: t.inkVariant }]}>
          Connect to the internet to download it (once; it then works offline)
        </Text>
      )}
      {state.phase === 'ready' && state.packs.length > 0 && (
        <Button
          mode="contained-tonal"
          icon="download"
          compact
          style={styles.button}
          onPress={() => void download(state.packs)}
          accessibilityLabel={`Download ${state.packs.map((p) => p.name).join(', ')}`}
        >
          {`Download ${state.packs.map((p) => p.name).join(' + ')} (${formatBytes(
            state.packs.reduce((n, p) => n + p.bytes, 0),
          )})`}
        </Button>
      )}
      {state.phase === 'ready' && state.unavailable.length > 0 && (
        <Text style={[styles.small, { color: t.inkVariant }]}>
          No download covers this area for {state.unavailable.map(gridLabel).join(', ')}
        </Text>
      )}
      {state.phase === 'downloading' && (
        <View style={styles.progress} accessibilityLabel="Downloading the grid">
          <ProgressBar progress={state.total > 0 ? state.done / state.total : 0} />
          <Text style={[styles.small, { color: t.inkVariant }]}>
            Downloading… {formatBytes(state.done)} of {formatBytes(state.total)}
          </Text>
        </View>
      )}
      {state.phase === 'error' && (
        <Text style={[styles.small, { color: t.status.gpsLostInk }]}>{state.message}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, marginTop: 2 },
  row: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  text: { fontSize: 15, flex: 1 },
  small: { fontSize: 13 },
  button: { alignSelf: 'flex-start' },
  progress: { gap: 4 },
});
