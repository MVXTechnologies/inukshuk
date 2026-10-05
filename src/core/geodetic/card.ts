/**
 * The geodetic-point summary card's content. Field operators rely on it, so:
 *
 * - coordinates and heights are the agency's own published values, as
 *   published (its digits, its datum, its epoch, its grid) — the app never
 *   recomputes one; the ONLY computed value is the map position, labelled
 *   "≈ WGS 84 · display, ±N m";
 * - every height carries its datum; chart / tidal datums get their own row and
 *   never pass for an orthometric height;
 * - agency wording (monument, designation) is shown verbatim;
 * - a field the mark doesn't have produces NO row (no "—" placeholders);
 * - there is always a link out: the agency datasheet, else the agency's page.
 */
import { datumAt, sourceAt, vdatumAt } from './catalog';
import type { GeodeticMark, MarkType } from './record';

export interface CardLine {
  text: string;
  /** Secondary text after the value (the datum, a note). */
  note?: string;
  /** Muted (secondary) line. */
  muted?: boolean;
  /**
   * What this line's own copy button puts on the clipboard: the value as
   * shown plus its datum / system label. Absent = no button (labels, prose).
   */
  copy?: string;
  /** Short name of the value, for the copy button's accessibility label. */
  copyName?: string;
}

export interface CardRow {
  /** Stable key (tests, React keys). */
  key: 'wgs84' | 'native' | 'heights' | 'chart' | 'elevation' | 'monument' | 'visit' | 'name';
  /** The short label shown on the left. */
  label: string;
  lines: CardLine[];
}

export interface CardChip {
  label: string;
  tone: 'type' | 'ok' | 'warn' | 'muted';
}

export interface GeodeticCardModel {
  title: string;
  subtitle: string;
  type: MarkType;
  chips: CardChip[];
  rows: CardRow[];
  link: { url: string; label: string };
  credit: string;
  /** What "Copy" puts on the clipboard: the published values, labelled. */
  copyText: string;
}

export const TYPE_LABEL: Record<MarkType, string> = {
  '3d': '3D',
  h: 'Horizontal',
  v: 'Vertical',
  gnss: 'GNSS station',
  u: 'Survey point',
};

const MONUMENT_LABEL: Record<string, string> = {
  disk: 'Disk',
  bolt: 'Bolt',
  pillar: 'Pillar',
  rod: 'Rod',
  pipe: 'Pipe',
  stone: 'Stone',
  block: 'Block',
  cut: 'Cut mark',
  pin: 'Pin',
  structure: 'Structure',
  antenna: 'Antenna',
  other: 'Other',
};

/**
 * Group a published number's integer digits in threes ("5186200.480" →
 * "5 186 200.480", narrow no-break spaces), the way the agencies print them.
 * The digits themselves are untouched.
 */
export function groupDigits(published: string): string {
  const m = /^([-+]?)(\d+)(\.\d*)?$/.exec(published.trim());
  if (!m) return published.trim();
  const [, sign = '', int = '', frac = ''] = m;
  return `${sign}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${frac}`;
}

/** The display position: decimal degrees, 6 places (≈ 0.1 m). */
export function formatLatLng(lat: number, lng: number): string {
  const la = `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lng).toFixed(6)}° ${lng >= 0 ? 'E' : 'W'}`;
  return `${la}, ${lo}`;
}

/** How far the drawn position may be from the mark's true WGS 84 position. */
export function displayAccuracyM(mark: GeodeticMark): number {
  const datum = datumAt(mark.datum);
  return Math.max(mark.posAccM ?? 0, mark.osm ? 1 : (datum?.wgsOffsetM ?? 2));
}

function sheetLink(mark: GeodeticMark): { url: string; label: string } | null {
  const source = sourceAt(mark.source);
  const fill = (template: string) => template.replace('{id}', encodeURIComponent(mark.id));
  if (mark.osm) {
    if (mark.url) return { url: mark.url, label: 'Datasheet' };
    return source?.sheet ? { url: fill(source.sheet), label: 'OpenStreetMap' } : null;
  }
  // The agency's own per-mark link wins over the source's template (some
  // report names can't be derived from the id, e.g. Queensland zero-pads).
  if (mark.url) return { url: mark.url, label: 'Full datasheet' };
  if (source?.sheet) return { url: fill(source.sheet), label: 'Full datasheet' };
  return source ? { url: source.licenceUrl, label: 'Agency page' } : null;
}

export function buildGeodeticCard(mark: GeodeticMark): GeodeticCardModel {
  const source = sourceAt(mark.source);
  const datum = datumAt(mark.datum);
  const datumLabel = datum ? `${datum.name}${datum.epoch ? ` · epoch ${datum.epoch}` : ''}` : '';
  const rows: CardRow[] = [];
  const copy: string[] = [`${mark.id}${source ? ` (${source.name})` : ''}`];

  // The agency's coordinates first: datum + epoch, then its published
  // geographic and grid values, verbatim.
  if (datum && (mark.geo || mark.grids.length > 0 || !mark.osm)) {
    const lines: CardLine[] = [{ text: datumLabel }];
    if (mark.geo) {
      lines.push({ text: mark.geo, copy: `${mark.geo} (${datumLabel})`, copyName: 'coordinates' });
    }
    for (const g of mark.grids) {
      lines.push({
        text: `E ${groupDigits(g.e)} · N ${groupDigits(g.n)}`,
        note: g.system,
        muted: true,
        copy: `${g.system}: E ${g.e} N ${g.n} (${datumLabel})`,
        copyName: g.system,
      });
    }
    rows.push({ key: 'native', label: 'Published', lines });
    if (!mark.geo) copy.push(datumLabel);
  }

  const accuracy = displayAccuracyM(mark);
  const accuracyText = accuracy < 1 ? accuracy.toFixed(1) : String(Math.round(accuracy));
  rows.push({
    key: 'wgs84',
    label: '≈ WGS 84',
    lines: [
      {
        text: formatLatLng(mark.lat, mark.lng),
        note: `display, ±${accuracyText} m`,
        copy: `${formatLatLng(mark.lat, mark.lng)} (≈ WGS 84, display ±${accuracyText} m)`,
        copyName: 'WGS 84 display position',
      },
    ],
  });

  const ortho: CardLine[] = [];
  const chart: CardLine[] = [];
  const unstated: CardLine[] = [];
  for (const h of mark.heights) {
    const vd = vdatumAt(h.vdatum);
    if (h.vdatum === undefined || !vd) {
      unstated.push({
        text: `${h.text} m`,
        note: 'datum not stated',
        copy: `Elevation ${h.text} m (datum not stated)`,
        copyName: 'elevation',
      });
    } else if (vd.kind === 'chart') {
      chart.push({
        text: `${h.text} m`,
        note: vd.name,
        copy: `${h.text} m ${vd.name}`,
        copyName: vd.name,
      });
    } else {
      ortho.push({
        text: `${h.text} m`,
        note: vd.name,
        ...(ortho.length > 0 ? { muted: true } : {}),
        copy: `H ${h.text} m ${vd.name}`,
        copyName: `${vd.name} height`,
      });
    }
  }
  if (mark.hEll !== undefined) {
    ortho.push({
      text: `${mark.hEll} m`,
      note: `ellipsoidal${datumLabel ? ` · ${datumLabel}` : ''}`,
      ...(ortho.length > 0 ? { muted: true } : {}),
      copy: `h ${mark.hEll} m ellipsoidal${datumLabel ? ` ${datumLabel}` : ''}`,
      copyName: 'ellipsoidal height',
    });
  }
  if (ortho.length > 0) rows.push({ key: 'heights', label: 'Heights', lines: ortho });
  if (chart.length > 0) rows.push({ key: 'chart', label: 'Chart datum', lines: chart });
  if (unstated.length > 0) rows.push({ key: 'elevation', label: 'Elevation', lines: unstated });

  const monument =
    mark.monumentText ?? (mark.monumentCode ? MONUMENT_LABEL[mark.monumentCode] : undefined);
  if (monument) {
    const lines: CardLine[] = [{ text: monument }];
    if (mark.lastVisit) lines.push({ text: `Last visited ${mark.lastVisit}`, muted: true });
    rows.push({ key: 'monument', label: 'Monument', lines });
  } else if (mark.lastVisit) {
    rows.push({ key: 'visit', label: 'Last visit', lines: [{ text: mark.lastVisit }] });
  }
  if (mark.name) rows.push({ key: 'name', label: 'Name', lines: [{ text: mark.name }] });

  const chips: CardChip[] = [{ label: TYPE_LABEL[mark.type], tone: 'type' }];
  if (!mark.osm) {
    chips.push(
      mark.status === 'ok'
        ? { label: 'Good condition', tone: 'ok' }
        : mark.status === 'damaged'
          ? { label: 'Damaged', tone: 'warn' }
          : { label: 'Condition unknown', tone: 'muted' },
    );
  }
  if (mark.legacy) chips.push({ label: 'Legacy datum', tone: 'muted' });

  const link = sheetLink(mark) ?? {
    url: `https://www.openstreetmap.org/?mlat=${mark.lat}&mlon=${mark.lng}#map=18/${mark.lat}/${mark.lng}`,
    label: 'Map',
  };
  // "Copy all" = every line's own copy, in card order (published values
  // first, the display position after them), so the two can never disagree.
  for (const row of rows) for (const line of row.lines) if (line.copy) copy.push(line.copy);
  return {
    title: mark.id,
    subtitle: source ? `${source.name} · ${source.network}` : 'Survey mark',
    type: mark.type,
    chips,
    rows,
    link,
    credit: source?.attribution ?? '',
    copyText: copy.join('\n'),
  };
}
