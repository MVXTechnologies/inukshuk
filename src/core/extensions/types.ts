/**
 * The pure half of a map extension (Settings → Extensions): what it is
 * called, where its tiles come from, what it draws, how it rides in offline
 * packs and how its persisted switches are named. The platform half (its
 * Settings body, overlays-panel row, map card, install hooks) is an
 * `ExtensionModule` in `@features/extensions`. See docs/ARCHITECTURE.md
 * § "Adding an extension".
 */
import type { LayerSpecification, SourceSpecification } from '@maplibre/maplibre-react-native';

import type { ExtensionKey } from './keys';

/**
 * A published tile archive on our host (`@data/datasets` resolves it to its
 * tile template and TileJSON). Usually one per extension; named apart so two
 * extensions could share one archive, or one extension move to a new one.
 */
export type DatasetId = 'geodetic' | 'tides';

/** One extension's persisted state (Settings → `extensions[key]`). */
export interface ExtensionPrefs {
  /** Epoch ms of the install ("Get"); 0 = not installed. */
  installedAt: number;
  /** Its layer switch (Settings and Map overlays › Extensions). */
  show: boolean;
  /**
   * "Offline in your regions": its tiles ride in offline packs. Read only by
   * extensions whose pack policy is `'opt-in'`; the others ignore it.
   */
  offline: boolean;
}

export type ExtensionPrefsMap = Record<ExtensionKey, ExtensionPrefs>;

/**
 * What the map hands an extension's style builder (`buildOsmStyle`'s
 * `options[key]`): its tile template, the theme and, when the map has no glyph
 * host of its own, ours. An extension adds its own fields (a filter, a live
 * GeoJSON layer) by extending this.
 */
export interface ExtensionStyleInput {
  /** Tile template; an extension may draw without (local data only). */
  tiles?: string;
  dark: boolean;
  /** Glyph host for its labels when the style has none yet. */
  glyphs?: string;
}

/** Fixed per style: the theme and the font stack the style's glyph host serves. */
export interface ExtensionStyleContext {
  theme: 'light' | 'dark';
  font: readonly string[];
}

/** An extension's share of a style: its sources (in order) and its layers (bottom → top). */
export interface ExtensionStyleBlock {
  sources: Record<string, SourceSpecification>;
  layers: LayerSpecification[];
}

/** A line of the map's ⓘ credits sheet, shown while the extension draws. */
export interface ExtensionCredit {
  label: string;
  credit: string;
  /** Link the line to the OpenStreetMap copyright page. */
  osmLink?: boolean;
}

export interface ExtensionDescriptor<I extends ExtensionStyleInput = ExtensionStyleInput> {
  /** Its name everywhere: Settings, the overlays row, credits ("Geodetic points"). */
  label: string;
  /** What it adds, lower case, for "Get survey marks, tide stations…". */
  teaser: string;
  dataset: DatasetId;
  /** The switches a fresh install starts from (`installedAt` is always 0). */
  defaults: Pick<ExtensionPrefs, 'show' | 'offline'>;
  /**
   * The flat settings keys the extension used before the registry (only for
   * extensions that shipped before it). Read when a settings file has no
   * `extensions` entry for it, and still written next to it, so a build from
   * before the registry (an OTA rollback) reads the same state. A new
   * extension has none.
   */
  legacySettings?: { installedAt: string; show: string; offline?: string };
  map: {
    /** The face of its labels: the map's regular or bold font stack. */
    fontWeight: 'regular' | 'bold';
    /** Its tile source id: what an offline pack holding its tiles names. */
    sourceId: string;
    /** Its sources and layers for the live map, an offline pack or a companion pack. */
    build(input: I, ctx: ExtensionStyleContext): ExtensionStyleBlock;
  };
  offline: {
    /**
     * When its tiles ride in a new offline region's pack:
     * - `'installed'`: always, once installed (small archives);
     * - `'opt-in'`: only with its "Offline in your regions" switch on.
     */
    packs: 'installed' | 'opt-in';
    /**
     * Regions downloaded before the install get a companion pack holding only
     * its tiles over the region's bounds (`@data/offline` companion packs).
     * Unset: no companion packs.
     */
    companion?: {
      minZoom: number;
      maxZoom: number;
      /** What the packs carry, for "Couldn't add the marks to Charlevoix". */
      items: string;
    };
  };
  credit: ExtensionCredit;
}

/** The style input type of a descriptor. */
export type StyleInputOf<D> = D extends ExtensionDescriptor<infer I> ? I : never;
