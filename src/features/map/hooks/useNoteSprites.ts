import { missingNoteSprites } from '@core/photos/notePins';
import type { TrackNote } from '@core/models';
import { cachedNoteSprite, makeNoteSprite } from '@data/photos/noteSprites';
import { useEffect, useMemo, useRef, useState } from 'react';

import { photoResizer } from '../../photos/photoResizer';

/**
 * The round map sprites of a trail's note photos (#742), by photo uri: the
 * cached ones at once, the others made one at a time in the background by
 * the photo resizer (a note shows its plain pin until its circle is ready).
 * A photo the resizer cannot read keeps its plain pin; it is not retried
 * while the screen stays open.
 */
export function useNoteSprites(
  notes: readonly TrackNote[] | undefined,
): (photoUri: string) => string | null {
  const [made, setMade] = useState<Readonly<Record<string, string>>>({});
  const failed = useRef(new Set<string>());

  const sprites = useMemo(() => {
    const out = new Map<string, string>();
    for (const n of notes ?? []) {
      if (!n.photoUri || out.has(n.photoUri)) continue;
      const uri = made[n.photoUri] ?? cachedNoteSprite(n.photoUri);
      if (uri) out.set(n.photoUri, uri);
    }
    return out;
  }, [notes, made]);

  useEffect(() => {
    const todo = missingNoteSprites(notes ?? [], (u) => sprites.get(u)).filter(
      (u) => !failed.current.has(u),
    );
    if (todo.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const uri of todo) {
        if (cancelled) return;
        try {
          const sprite = await makeNoteSprite(uri, photoResizer);
          if (!cancelled) setMade((m) => ({ ...m, [uri]: sprite }));
        } catch {
          failed.current.add(uri);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notes, sprites]);

  return useMemo(() => (uri: string) => sprites.get(uri) ?? null, [sprites]);
}
