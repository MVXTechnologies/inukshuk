import { tileTemplatesFromTileJson } from '@core/geo/tileJson';
import { useEffect, useState } from 'react';

/**
 * Resolves the OpenFreeMap TileJSON into concrete vector-tile URL templates
 * for the labels/coastlines overlay (weather wave B). maplibre-native can't
 * consume the TileJSON `url` form (silent no-render), and the templates
 * carry a dated deployment path that changes on OpenFreeMap redeploys — so
 * they are fetched once per app session and cached in-module. Failure
 * degrades to null and the overlay simply doesn't draw (the dim treatment
 * remains as the fallback), matching the weather code's silence contract.
 */

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

let cached: readonly string[] | null = null;
let inflight: Promise<readonly string[] | null> | null = null;

async function resolveTiles(): Promise<readonly string[] | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    const res = await fetch(TILEJSON_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return tileTemplatesFromTileJson(await res.json());
  } catch {
    return null;
  }
}

/** Test-only escape hatch: reset the module cache between jest cases. */
export function resetOverlayLabelTilesForTests(): void {
  cached = null;
  inflight = null;
}

export function useOverlayLabelTiles(enabled: boolean): readonly string[] | null {
  const [tiles, setTiles] = useState<readonly string[] | null>(cached);

  useEffect(() => {
    if (!enabled || cached !== null) return;
    let alive = true;
    inflight ??= resolveTiles().then((t) => {
      cached = t;
      // A failed resolve may retry on the next enable; don't pin the null.
      if (t === null) inflight = null;
      return t;
    });
    void inflight.then((t) => {
      if (alive) setTiles(t);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return enabled ? tiles : null;
}
