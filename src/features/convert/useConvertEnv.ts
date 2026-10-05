import { liteEngine } from '@core/convert/lite';
import type { Pack, PackIndex } from '@core/convert/packs';
import type { EvalEnv } from '@core/convert/session';
import { installedGrids, installPack, packIndex } from '@data/projGrids';
import { initNativeProj, nativeEngine, nativeProjInfo } from '@lib/nativeProj';
import { useConvertStore } from '@state/convertStore';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface ConvertEnvState {
  env: EvalEnv;
  /** PROJ is in this build (else lite: grid-free conversions only). */
  native: boolean;
  index: PackIndex | null;
  downloading: { id: string; done: number; total: number } | null;
  downloadError: string | null;
  download: (pack: Pack) => Promise<void>;
}

/**
 * What a Convert evaluation runs on: the PROJ module when this build has it
 * (`lite.ts` otherwise), the grids on the device, and the pack index for
 * "Download Québec pack".
 */
export function useConvertEnv(): ConvertEnvState {
  const gridsVersion = useConvertStore((s) => s.gridsVersion);
  const gridsChanged = useConvertStore((s) => s.gridsChanged);
  const native = useMemo(() => {
    const e = nativeEngine();
    if (e) initNativeProj([]);
    return e;
  }, []);
  // Re-read the packs on disk whenever one is installed or removed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const installed = useMemo(() => installedGrids(), [gridsVersion]);
  const [index, setIndex] = useState<PackIndex | null>(null);
  const [downloading, setDownloading] = useState<ConvertEnvState['downloading']>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    packIndex({ network: true })
      .then((i) => alive && setIndex(i))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const download = useCallback(
    async (pack: Pack) => {
      setDownloadError(null);
      setDownloading({ id: pack.id, done: 0, total: pack.bytes });
      try {
        await installPack(pack, (done, total) => setDownloading({ id: pack.id, done, total }));
        gridsChanged();
      } catch (e) {
        setDownloadError(`${pack.name}: ${(e as Error).message}`);
      } finally {
        setDownloading(null);
      }
    },
    [gridsChanged],
  );

  const bundledDir = nativeProjInfo()?.bundledGridDir;
  const env = useMemo<EvalEnv>(
    () => ({ engine: native ?? liteEngine, installed, ...(bundledDir ? { bundledDir } : {}) }),
    [native, installed, bundledDir],
  );
  return { env, native: native !== null, index, downloading, downloadError, download };
}
