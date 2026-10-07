/**
 * The map's extension host (MapScreen): which extensions are drawn, their
 * style inputs, a tap → the extension it hit, its selection ring and symbol
 * images — every registered extension the same way, in registry order.
 *
 * One extension card at a time: MapScreen keeps a single `ExtensionHit`, so
 * opening one closes the others, a waypoint pin or a bare tap closes it, and
 * a card only shows while its extension is drawn.
 */
import { EXTENSION_KEYS, type ExtensionKey } from '@core/extensions/keys';
import type { ExtensionStyleOptions } from '@core/extensions/registry';
import { shownExtensions } from '@core/extensions/state';
import { vectorGlyphsUrl } from '@data/basemapTiles';
import { Images } from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { useMemo, type ReactNode, type Ref } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { availableExtensions, extensionTilesUrl } from './availability';
import { EXTENSION_MAP_MODULES } from './mapModules';
import type { ExtensionCardHost, ExtensionTap } from './types';

/** What a map tap found: the extension, and its own record (a mark, a station). */
export interface ExtensionHit {
  key: ExtensionKey;
  value: unknown;
}

const NO_EXTRAS = {};

/**
 * The extensions drawn now (installed, published, switched on; draw order)
 * and their entries for `buildOsmStyle`'s options — a stable object until
 * one of them changes.
 */
export function useExtensionMap({ dark, offlineOnly }: { dark: boolean; offlineOnly: boolean }): {
  shown: readonly ExtensionKey[];
  styleOptions: ExtensionStyleOptions;
} {
  const prefs = useSettingsStore((s) => s.extensions);
  const shownKey = shownExtensions({ available: availableExtensions(), prefs }).join(',');
  const shown = useMemo(
    () => (shownKey === '' ? [] : (shownKey.split(',') as ExtensionKey[])),
    [shownKey],
  );
  const extras: object[] = [];
  for (const key of EXTENSION_KEYS) {
    const map = EXTENSION_MAP_MODULES[key];
    // The registry is static: the same hooks run in the same order on every render.
    extras.push(map ? map.useStyleExtras(shown.includes(key), { offlineOnly }) : NO_EXTRAS);
  }
  const styleOptions = useMemo(() => {
    const out: ExtensionStyleOptions = {};
    const glyphs = vectorGlyphsUrl();
    for (const [i, key] of EXTENSION_KEYS.entries()) {
      const tiles = shown.includes(key) ? extensionTilesUrl(key) : null;
      if (tiles === null) continue;
      // Our glyph host for their labels, when the build has one.
      out[key] = { tiles, dark, ...extras[i], ...(glyphs !== null ? { glyphs } : {}) };
    }
    return out;
    // One extras entry per registered extension: a fixed-length list, compared item by item.
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  }, [shown, dark, ...extras]);
  return { shown, styleOptions };
}

/** The extension a tap hits, asked top-down (the symbol drawn on top wins), or null. */
export async function hitTestExtensions(
  shown: readonly ExtensionKey[],
  tap: ExtensionTap,
): Promise<ExtensionHit | null> {
  for (const key of [...shown].reverse()) {
    const map = EXTENSION_MAP_MODULES[key];
    if (!map) continue;
    const value = await map.hitTest(tap);
    if (value !== null) return { key, value };
  }
  return null;
}

/** Whether the hit's card brings it into view above the card (once, at first layout). */
export function extensionRecenters(hit: ExtensionHit): boolean {
  return EXTENSION_MAP_MODULES[hit.key]?.recenterOnCard ?? false;
}

/** Where a hit is: [lng, lat]. */
export function extensionHitPosition(hit: ExtensionHit): [number, number] | null {
  return EXTENSION_MAP_MODULES[hit.key]?.position(hit.value) ?? null;
}

/** The symbol images the drawn extensions' layers name. */
export function ExtensionImages({
  shown,
  dark,
}: {
  shown: readonly ExtensionKey[];
  dark: boolean;
}): ReactNode {
  return shown.map((key) => {
    const map = EXTENSION_MAP_MODULES[key];
    return map ? <Images key={key} images={map.images(dark ? 'dark' : 'light')} /> : null;
  });
}

/** The ring under the hit whose card is up. */
export function renderExtensionSelection(
  hit: ExtensionHit,
  ctx: { dark: boolean; beforeId: string },
): ReactNode {
  return EXTENSION_MAP_MODULES[hit.key]?.renderSelection(hit.value, ctx) ?? null;
}

/**
 * The hit's bottom card in its dock (the bottom-card slot: style, layout and
 * the dock's ref are the map's), testID'd per extension for Maestro.
 */
export function ExtensionCardDock({
  hit,
  host,
  style,
  dockRef,
  onLayout,
}: {
  hit: ExtensionHit;
  host: ExtensionCardHost;
  style: StyleProp<ViewStyle>;
  dockRef: Ref<View>;
  onLayout: () => void;
}): ReactNode {
  const map = EXTENSION_MAP_MODULES[hit.key];
  if (!map) return null;
  return (
    <View
      style={style}
      pointerEvents="box-none"
      testID={map.cardDockTestID}
      ref={dockRef}
      onLayout={onLayout}
    >
      {map.renderCard(hit.value, host)}
    </View>
  );
}

export type { ExtensionCardHost } from './types';
