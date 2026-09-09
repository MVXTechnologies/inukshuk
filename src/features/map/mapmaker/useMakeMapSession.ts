import type { BoundingBox } from '@core/models';
import { useCallback, useRef, useState } from 'react';
import type { ComposeHandle, MakeMapOptions } from './composeMapPdf';
import type { MakeMapProgress } from './MakeMapSheet';
import { makeMap } from './makeMap';

/** The map maker's UI state: region box → options sheet → compose → Library. */
export type MakeMapState =
  | null
  | { phase: 'select' }
  | { phase: 'options'; bbox: BoundingBox }
  | { phase: 'generating'; bbox: BoundingBox; progress: MakeMapProgress };

/**
 * Owns one map-maker session at a time (#309). Every callback of a running
 * `makeMap` is gated on it still being THE current, un-cancelled operation:
 * a Cancel followed by a fresh options sheet (or a second make) must not
 * have the first run's completion reset — or reopen — the newer editor.
 * A late success still announces itself: the map really is in the library.
 */
export function useMakeMapSession({ showSnack }: { showSnack: (message: string) => void }) {
  const [makeMapState, setMakeMapState] = useState<MakeMapState>(null);
  const handleRef = useRef<ComposeHandle>({ aborted: false });

  const startMakeMap = useCallback(
    (bbox: BoundingBox, options: MakeMapOptions) => {
      const handle: ComposeHandle = { aborted: false };
      handleRef.current = handle;
      const isCurrent = () => handleRef.current === handle && !handle.aborted;
      setMakeMapState({ phase: 'generating', bbox, progress: { phase: 'tiles', frac: 0 } });
      void makeMap(
        bbox,
        options,
        (phase, frac) => {
          if (isCurrent())
            setMakeMapState((s) =>
              s?.phase === 'generating' ? { ...s, progress: { phase, frac } } : s,
            );
        },
        handle,
      )
        .then((doc) => {
          if (isCurrent()) setMakeMapState(null);
          showSnack(`"${doc.name}" saved to the library`);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setMakeMapState({ phase: 'options', bbox });
          const message = err instanceof Error ? err.message : 'unknown error';
          showSnack(`Couldn't make the map: ${message}`);
        });
    },
    [showSnack],
  );

  /** Cancel whatever is running (the composer stops at its next check) and close the sheet. */
  const cancelMakeMap = useCallback(() => {
    handleRef.current.aborted = true;
    setMakeMapState(null);
  }, []);

  return { makeMapState, setMakeMapState, startMakeMap, cancelMakeMap };
}
