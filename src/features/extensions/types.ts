/**
 * The platform half of a map extension, one registry per surface so each
 * surface loads only what it shows: Settings → Extensions
 * (`./settingsModules`), the overlays sheet's Extensions tab
 * (`./panelEntries`) and the live map (`./mapModules`, the only one that
 * loads MapLibre's components). The pure half (label, dataset, style,
 * offline policy, credit) is its `ExtensionDescriptor` in `@core/extensions`.
 * See docs/ARCHITECTURE.md § "Adding an extension".
 */
import type { ConvertRequest } from '@core/convert/prefill';
import type { ComponentType, ReactNode } from 'react';
import type { ImageRequireSource } from 'react-native';

/** What the overlays sheet hands an extension's row in its Extensions tab. */
export interface ExtensionPanelEntryProps {
  /** Open the geodetic filter in the sheet (the one sub-page an entry has today). */
  onOpenGeodeticFilter: () => void;
  /** Close the overlays sheet (an entry opening its own sheet, e.g. the receiver). */
  onClose: () => void;
}

/** What the map hands an extension's bottom card: the slot's state and its actions. */
export interface ExtensionCardHost {
  /** The recording panel is up: the card floats above it. */
  floating: boolean;
  /** Offline-only mode: links can't open. */
  offline: boolean;
  /** Close the card. */
  close: () => void;
  /** Make this point the destination and close the card. */
  navigateTo: (lat: number, lng: number) => void;
  /** Open `url` in the browser; `failMessage` is toasted when it can't. */
  openLink: (url: string, failMessage: string) => void;
  /** Copy `text` and toast `message`. */
  copy: (text: string, message: string) => void;
  /** Open Convert, prefilled. */
  openConvert: (req: ConvertRequest) => void;
}

/** A map tap, for an extension's hit test (map pixels and the tapped position). */
export interface ExtensionTap {
  map: {
    queryRenderedFeatures: (
      box: [[number, number], [number, number]],
      options: { layers: string[] },
    ) => Promise<unknown[]>;
  };
  px: number;
  py: number;
  lngLat: readonly [number, number];
}

/**
 * An extension on the live map (`./mapModules`): what it adds to its style input, its
 * symbol images, its tap → card. `H` is what a tap finds (a mark, a
 * station). Methods, not function properties: the registry holds every
 * extension's map module under one type.
 */
export interface ExtensionMapModule<H> {
  /**
   * The extension's own style-input fields (a filter, live data) — a hook,
   * called on every map render in registry order; return a stable object.
   * `active`: the extension is drawn.
   */
  useStyleExtras(active: boolean, ctx: { offlineOnly: boolean }): object;
  /** The symbol images its layers name. */
  images(theme: 'light' | 'dark'): Record<string, ImageRequireSource>;
  /** What a tap at `tap` hits, or null (nothing there, or the map mid-teardown). */
  hitTest(tap: ExtensionTap): Promise<H | null>;
  /** Where a hit is: [lng, lat]. */
  position(hit: H): [number, number];
  /** The ring under the hit whose card is up (a native layer, drawn under the markers). */
  renderSelection(hit: H, ctx: { dark: boolean; beforeId: string }): ReactNode;
  /** Its bottom card for a hit. */
  renderCard(hit: H, host: ExtensionCardHost): ReactNode;
  /** The card dock's testID (Maestro). */
  cardDockTestID: string;
  /** Bring the hit into the map left visible above the card, once, at the card's first layout. */
  recenterOnCard: boolean;
}

/** An extension in Settings → Extensions (`./settingsModules`): its entry and install hooks. */
export interface ExtensionSettingsModule {
  /** What it is and "Get", or its rows once installed (in `ExtensionSettingsShell`). */
  Settings: ComponentType;
  /** After "Get" (the install and its switch on are already saved). */
  onInstall?(): void;
  /** After "Remove" (the uninstall is already saved). */
  onRemove?(): Promise<void>;
  /** After its "Offline in your regions" switch changed (already saved). */
  onOfflineChange?(on: boolean): Promise<void>;
}
