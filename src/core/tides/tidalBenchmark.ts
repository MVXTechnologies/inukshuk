/**
 * Tidal benchmarks inside the geodetic-points layer (DESIGN §2.1): a survey
 * mark whose height above chart datum a hydrographic office published. The
 * geodetic build adds these tile keys to the mark
 * (`infra/tiles/nas/tides/join_geodetic.py` → `geodetic/tiles.py`):
 *
 * | key | meaning |
 * |-----|---------|
 * | `cd` | height above chart datum, as published (e.g. "4.277") |
 * | `cs` | its tide station, `{source key}:{station id}` (e.g. "us-coops:8518750") |
 * | `cN` | the station's name | `cn` | chart-datum kind (tide catalogue `cdKinds`) |
 * | `cdt` | date of the CD height | `cm` | height above MHW, when published |
 * | `cu` | 1 = joined by the agency id, no levelled height to cross-check |
 *
 * Everything tidal lives here so the geodetic modules only hook it in:
 * parsing (`parseTidalHeight`), the map symbol and label (`tidalIcon`,
 * `buildTidalLabelLayer`), and the card row (`tidalCardRow`). The CD height is
 * a separate row with its own source — never mixed with the orthometric
 * heights, and no CD-derived orthometric value is ever shown.
 */
import type { SymbolLayerSpecification } from '@maplibre/maplibre-react-native';
import { cdKind, TIDE_CATALOG, type TideSource } from './catalog';
import palette from './palette.json';

export interface TidalHeight {
  cd: string;
  station: string;
  stationName: string;
  cdKind: string;
  date?: string;
  mhw?: string;
  unchecked?: boolean;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** The tidal block of a geodetic tile feature, or undefined for an ordinary mark. */
export function parseTidalHeight(
  props: Readonly<Record<string, unknown>> | null | undefined,
): TidalHeight | undefined {
  if (!props) return undefined;
  const cd = str(props.cd);
  const station = str(props.cs);
  if (cd === undefined || !/^-?\d+(\.\d+)?$/.test(cd) || station === undefined) return undefined;
  const t: TidalHeight = {
    cd,
    station,
    stationName: str(props.cN) ?? station,
    cdKind: str(props.cn) ?? '',
  };
  const date = str(props.cdt);
  if (date !== undefined) t.date = date;
  const mhw = str(props.cm);
  if (mhw !== undefined && /^-?\d+(\.\d+)?$/.test(mhw)) t.mhw = mhw;
  if (props.cu === 1 || props.cu === '1') t.unchecked = true;
  return t;
}

/** The hydrographic office behind a tidal height ("us-coops:…" → NOAA CO-OPS). */
export function tidalSource(t: TidalHeight): TideSource | undefined {
  return TIDE_CATALOG.sources.find((s) => t.station.startsWith(`${s.key}:`));
}

// ---------------------------------------------------------------- map

/**
 * Wrap the geodetic icon expression: a mark with `cd` draws the tidal
 * benchmark symbol (red disc crossed by a wave, owner Q2a), whatever its type.
 * A plain `case` on a property — no zoom inside.
 */
export function tidalIcon(theme: 'light' | 'dark', otherwise: unknown): unknown {
  return ['case', ['has', 'cd'], `geodetic-tbm-${theme}`, otherwise];
}

export const TIDAL_LABEL_LAYER = 'geodetic-tidal-labels';

/** From z15: "ID · CD 4.277" in the tidal red (the hydrographic office's digits). */
export function buildTidalLabelLayer(options: {
  theme: 'light' | 'dark';
  font: readonly string[];
  source: string;
  sourceLayer: string;
}): SymbolLayerSpecification {
  const c = palette[options.theme];
  return {
    id: TIDAL_LABEL_LAYER,
    type: 'symbol',
    source: options.source,
    'source-layer': options.sourceLayer,
    minzoom: 15,
    filter: ['has', 'cd'],
    layout: {
      'text-field': ['concat', ['get', 'i'], ' · CD ', ['get', 'cd']] as unknown as string,
      'text-font': [...options.font],
      'text-size': 11,
      'text-anchor': 'left',
      'text-offset': [0.9, 0],
      'text-max-width': 14,
      'text-optional': true,
    },
    paint: {
      'text-color': c.tidal,
      'text-halo-color': c.labelHalo,
      'text-halo-width': 1.3,
    },
  };
}

// ---------------------------------------------------------------- card

export interface TidalLine {
  text: string;
  note?: string;
  muted?: boolean;
  /** Clipboard text for this line's copy button (the value with its datum). */
  copy?: string;
  /** Short name of the value, for the copy button's accessibility label. */
  copyName?: string;
}

/** The "Chart datum" row of a tidal benchmark's card (mockup 04). */
export function tidalCardRow(t: TidalHeight): { label: string; lines: TidalLine[] } {
  const kind = cdKind(t.cdKind);
  const cdLabel = kind?.label ?? 'chart datum';
  const stationId = t.station.slice(t.station.indexOf(':') + 1);
  const source = tidalSource(t);
  const lines: TidalLine[] = [
    {
      text: `${t.cd} m above ${cdLabel}`,
      note: `CD of ${t.stationName} (${stationId})`,
      copy: `CD height = ${t.cd} m above ${cdLabel} (${t.stationName} ${stationId}${
        source ? `, ${source.name}` : ''
      }${t.date ? ` ${t.date}` : ''})`,
      copyName: 'chart-datum height',
    },
  ];
  if (t.mhw) {
    lines.push({
      text: `${t.mhw} m above MHW`,
      muted: true,
      copy: `${t.mhw} m above MHW (${t.stationName} ${stationId})`,
      copyName: 'height above MHW',
    });
  }
  lines.push({
    text: `${source?.name ?? 'Hydrographic office'}${t.date ? ` · ${t.date}` : ''} · ${
      t.unchecked
        ? 'no levelled height to cross-check'
        : 'agrees with the levelled height (≤ 10 cm)'
    }`,
    muted: true,
  });
  return { label: 'Chart datum', lines };
}

/** The card footer's extra credit for a tidal benchmark. */
export function tidalCredit(t: TidalHeight): string {
  const s = tidalSource(t);
  return `${s ? `${s.attribution} · ` : ''}Not for navigation`;
}
