import type { BoundingBox } from '@core/models';
import { useCallback, useRef, useState } from 'react';
import type { ComposeHandle, MakeMapOptions } from './composeMapPdf';
import type { MakeMapProgress } from './MapMakerEditor';
import { makeMap } from './makeMap';

/**
 * The map maker's UI state: editor → compose → Library.
 *
 * There is no region-selection phase any more (#349). The editor IS the
 * selection — a sheet framed over the live map — so the bbox is read off the
 * camera at the moment Create is tapped rather than carried through the state.
 */
export type MakeMapState =
  null | { phase: 'editing' } | { phase: 'generating'; progress: MakeMapProgress };

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
      setMakeMapState({ phase: 'generating', progress: { phase: 'tiles', frac: 0 } });
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
          // A few base tiles that never arrived print as blank paper (#460);
          // the user should know before they trust the sheet on a trail.
          const missing = handle.missingTiles ?? 0;
          showSnack(
            missing > 0
              ? `"${doc.name}" saved — ${missing} map ${missing === 1 ? 'tile' : 'tiles'} couldn't be downloaded and ${missing === 1 ? 'is' : 'are'} blank`
              : `"${doc.name}" saved to the library`,
          );
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          // Back to the editor with the frame intact, so a retry is one tap.
          setMakeMapState({ phase: 'editing' });
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
