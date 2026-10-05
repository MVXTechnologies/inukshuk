/**
 * The tide-station card's content (mockup 03). Field operators rely on it, so:
 *
 * - every level is the agency's published number above chart datum, with the
 *   agency's own code; the other two columns are the SAME level in the
 *   national datum and as an ellipsoidal height, by the sign convention
 *   H_X = H_CD + CD_in_X, at the precision of the coarser input;
 * - the ellipsoid column only exists when the build had an agency oracle
 *   confirm that station's value (otherwise the card says why it is absent);
 * - chart datum is named for what it is at this station (MLLW, ZH, LAT…);
 *   JMA's tide-table datum is never called chart datum;
 * - the reference-port fallback is a separate block, labelled as the
 *   reference port's own levels above ITS chart datum — never merged in;
 * - every value has a copy string carrying its datum ("MHHW = 0.695 m
 *   NAVD88"), plus one for the whole table; copies use an ASCII minus;
 * - "Not for navigation" and the source credit are always there.
 */
import { formatLatLng } from '@core/geodetic/card';
import { cdKind, levelName, nationalName, tideSourceAt } from './catalog';
import { CHS_CGVD2013_NOTE } from './chs';
import { addPublished, displayNumber } from './published';
import type { PublishedLevel, StationKind, TideStation } from './station';

export interface TideCell {
  /** Display text (typographic minus). */
  text: string;
  /** Clipboard text, with its datum. */
  copy: string;
  /** Screen-reader label for the cell's copy action. */
  a11y: string;
}

export interface TideColumn {
  label: string;
  /** Second header line (frame, epoch). */
  sub?: string;
}

export interface TideRow {
  code: string;
  name?: string;
  /** One per column; null where that column has no value. */
  cells: (TideCell | null)[];
  /** The chart-datum row (0 in its own column). */
  datum?: boolean;
  copy: string;
}

export interface TideChip {
  label: string;
  tone: 'station' | 'live' | 'muted' | 'warn';
}

export interface TideCardModel {
  title: string;
  subtitle: string;
  chips: TideChip[];
  position: TideCell & { note: string };
  columns: TideColumn[];
  rows: TideRow[];
  /** "Recorded high 4.280 (2012-10-30) · low −1.307 (1976-02-02) above MLLW". */
  extremes?: string;
  refPort?: { title: string; rows: { code: string; name?: string; cell: TideCell }[] };
  cdBox: { title: string; values: TideCell[]; notes: string[] };
  tableCopy: string;
  link: { url: string; label: string };
  credit: string;
  live?: 'coops' | 'kv' | 'chs';
  /** The CD label used everywhere on this card ("MLLW", "ZH", "CD"…). */
  cdLabel: string;
  /** A licence notice to show in full on the card (CHS's). */
  notice?: string;
}

export const NOT_FOR_NAVIGATION = 'Not for navigation';

const KIND_LABEL: Record<StationKind, string> = {
  gauge: 'Live gauge',
  ref: 'Predictions',
  sec: 'Secondary station',
  hist: 'Historic datums',
};

function ascii(text: string): string {
  return text.replace('−', '-');
}

function cell(text: string, copy: string, a11y: string): TideCell {
  return { text: displayNumber(text), copy: ascii(copy), a11y };
}

function frameLabel(e: { frame: string; epoch?: string }): string {
  return `${e.frame}${e.epoch ? ` · epoch ${e.epoch}` : ''}`;
}

export function buildTideCard(s: TideStation): TideCardModel {
  const source = tideSourceAt(s.source);
  const kind = cdKind(s.cdKind);
  const cdLabel = kind?.label ?? 'CD';
  const aboveCd = s.cdKind === 'jma-tt' ? 'above the tide-table datum' : `above ${cdLabel}`;
  const national = s.national[0];
  const natLabel = national ? nationalName(national.datum) : undefined;
  const ell = s.ellipsoid;
  const ellLabel = ell ? `h ${frameLabel(ell)}` : undefined;

  const columns: TideColumn[] = [{ label: cdLabel, sub: 'chart datum' }];
  if (s.cdKind === 'jma-tt') columns[0] = { label: 'Tide-table datum' };
  if (natLabel) columns.push({ label: natLabel });
  if (ell) columns.push({ label: 'Ellipsoid', sub: frameLabel(ell) });

  const rowFor = (lv: PublishedLevel): TideRow => {
    const name = levelName(lv.code);
    const cells: (TideCell | null)[] = [
      cell(lv.text, `${lv.code} = ${lv.text} m ${aboveCd}`, `Copy ${lv.code} above chart datum`),
    ];
    const parts = [`${lv.text} m ${aboveCd}`];
    if (national && natLabel) {
      const v = addPublished(lv.text, national.text);
      cells.push(
        v === null
          ? null
          : cell(v, `${lv.code} = ${v} m ${natLabel}`, `Copy ${lv.code} in ${natLabel}`),
      );
      if (v !== null) parts.push(`${v} m ${natLabel}`);
    }
    if (ell && ellLabel) {
      const v = addPublished(lv.text, ell.text);
      cells.push(
        v === null
          ? null
          : cell(v, `${lv.code} = ${v} m ${ellLabel}`, `Copy ${lv.code} ellipsoidal height`),
      );
      if (v !== null) parts.push(`${v} m ${ellLabel}`);
    }
    return {
      code: lv.code,
      ...(name ? { name } : {}),
      cells,
      copy: ascii(`${lv.code}${name ? ` (${name})` : ''}: ${parts.join(' · ')}`),
    };
  };

  const rows = s.levels.map(rowFor);
  // The chart-datum row: 0 in its own column, the published offsets in the others.
  const datumCells: (TideCell | null)[] = [cell('0', `CD = 0 m ${cdLabel}`, 'Copy chart datum')];
  const datumParts: string[] = [];
  if (national && natLabel) {
    datumCells.push(
      cell(
        national.text,
        `CD (${cdLabel}) = ${national.text} m ${natLabel}`,
        `Copy chart datum in ${natLabel}`,
      ),
    );
    datumParts.push(`${national.text} m ${natLabel}`);
  }
  if (ell && ellLabel) {
    datumCells.push(
      cell(
        ell.text,
        `CD (${cdLabel}) = ${ell.text} m ${ellLabel}`,
        'Copy chart datum ellipsoidal height',
      ),
    );
    datumParts.push(`${ell.text} m ${ellLabel}`);
  }
  if (datumCells.length > 1 || rows.length > 0) {
    rows.push({
      code: s.cdKind === 'jma-tt' ? 'Datum' : 'Chart datum',
      cells: datumCells,
      datum: true,
      copy: ascii(
        `Chart datum (${cdLabel}) = ${datumParts.length ? datumParts.join(' · ') : `0 m ${cdLabel}`}`,
      ),
    });
  }

  let extremes: string | undefined;
  if (s.extremes.length > 0) {
    const fmt = (l: PublishedLevel) => `${displayNumber(l.text)}${l.date ? ` (${l.date})` : ''}`;
    const hi = s.extremes.find((e) => e.code === 'HOWL');
    const lo = s.extremes.find((e) => e.code === 'LOWL');
    const parts = [hi ? `Recorded high ${fmt(hi)}` : null, lo ? `low ${fmt(lo)}` : null].filter(
      (p): p is string => p !== null,
    );
    if (parts.length) extremes = `${parts.join(' · ')} ${aboveCd}`;
  }

  // Reference-port fallback: this station lacks HAT/LAT; show the port's own.
  let refPort: TideCardModel['refPort'];
  const have = new Set(s.levels.map((l) => l.code));
  if (s.refPort && !(have.has('HAT') && have.has('LAT'))) {
    const missing = s.refPort.levels.filter(
      (l) => !have.has(l.code) && (l.code === 'HAT' || l.code === 'LAT'),
    );
    if (missing.length > 0) {
      refPort = {
        title: `Reference port ${s.refPort.name} (${s.refPort.id}) · its own levels above its ${cdLabel}`,
        rows: missing.map((l) => {
          const name = levelName(l.code);
          return {
            code: l.code,
            ...(name ? { name } : {}),
            cell: cell(
              l.text,
              `${l.code} = ${l.text} m above ${cdLabel} at reference port ${s.refPort?.name ?? ''} (${s.refPort?.id ?? ''})`,
              `Copy reference port ${l.code}`,
            ),
          };
        }),
      };
    }
  }

  // The chart-datum box: what CD is here, its offsets, and how far to trust each.
  const values: TideCell[] = [];
  // Every national offset the agency publishes (CHS: CGVD2013, CGVD28, IGLD85);
  // the table's middle column uses the first.
  for (const n of s.national) {
    const label = nationalName(n.datum);
    values.push({
      text: `${displayNumber(n.text)} m ${label}`,
      copy: ascii(`CD (${cdLabel}) = ${n.text} m ${label}`),
      a11y: `Copy chart datum in ${label}`,
    });
  }
  if (ell && ellLabel) {
    values.push({
      text: `h ${displayNumber(ell.text)} m ${frameLabel(ell)}`,
      copy: ascii(`CD (${cdLabel}) = ${ell.text} m ${ellLabel}`),
      a11y: 'Copy chart datum ellipsoidal height',
    });
  }
  const notes: string[] = [];
  if (kind) notes.push(kind.description);
  if (national && natLabel) {
    notes.push(
      `${s.national.length > 1 ? 'Offsets' : `${natLabel} offset`} as published by ${source?.name ?? 'the agency'}.`,
    );
  }
  if (s.flags.includes('chs') && s.national.some((n) => n.datum === 'CGVD2013')) {
    notes.push(CHS_CGVD2013_NOTE);
  }
  if (ell) {
    const delta = Math.abs(ell.deltaM * 100).toFixed(1);
    notes.push(
      ell.checkedBy === ''
        ? `Ellipsoidal height as published by ${source?.name ?? 'the agency'} (${ell.basis}).`
        : ell.how === 'published'
          ? `Ellipsoidal height published by ${source?.name ?? 'the agency'}; agrees with ${ell.checkedBy} within ${delta} cm.`
          : `Ellipsoidal height derived (${ell.basis}); confirmed by ${ell.checkedBy} within ${delta} cm. About ±5 cm.`,
    );
  } else if (s.flags.includes('chs')) {
    notes.push(
      'No ellipsoidal height: CHS publishes no NAD83(CSRS) offset here, and none is derived on the device.',
    );
  } else if (national) {
    notes.push('No ellipsoidal height: no agency value confirms one at this station.');
  }
  if (s.epoch) notes.push(`Tidal epoch ${s.epoch}.`);
  if (s.landUpliftCmYr) notes.push(`Land uplift ${s.landUpliftCmYr} cm/yr.`);

  const source0 = source?.name ?? 'Tide station';
  const subtitle = [s.id, source0, s.zone].filter(Boolean).join(' · ');
  const chips: TideChip[] = [{ label: 'Tide station', tone: 'station' }];
  chips.push({ label: KIND_LABEL[s.kind], tone: s.kind === 'gauge' ? 'live' : 'muted' });
  chips.push({ label: NOT_FOR_NAVIGATION, tone: 'warn' });

  const pos = formatLatLng(s.lat, s.lng);
  const posNote = s.posAccM
    ? `station position, ±${s.posAccM >= 1000 ? `${s.posAccM / 1000} km` : `${s.posAccM} m`} (as published)`
    : 'station position, as published';

  const header = ['Level', `above ${cdLabel}`, natLabel, ellLabel].filter(
    (h): h is string => h !== undefined,
  );
  const tableLines = [
    `${s.name} (${s.id}) · ${source?.name ?? ''} · tidal levels, metres`,
    header.join('\t'),
    ...rows.map((r) => [r.code, ...r.cells.map((c) => (c ? ascii(c.text) : ''))].join('\t')),
  ];
  if (refPort) {
    tableLines.push(ascii(refPort.title));
    for (const r of refPort.rows) tableLines.push(`${r.code}\t${ascii(r.cell.text)}`);
  }
  tableLines.push(...notes, `${source?.attribution ?? ''} · ${NOT_FOR_NAVIGATION}`);

  const page = source?.page.replace('{id}', encodeURIComponent(s.id));
  return {
    title: s.name,
    subtitle,
    chips,
    position: {
      ...cell(pos, `${s.name} (${s.id}): ${pos}`, 'Copy station position'),
      note: posNote,
    },
    columns,
    rows,
    ...(extremes ? { extremes } : {}),
    ...(refPort ? { refPort } : {}),
    cdBox: {
      title: s.cdKind === 'jma-tt' ? 'Tide-table datum' : `Chart datum (${cdLabel})`,
      values,
      notes,
    },
    tableCopy: tableLines.join('\n'),
    link: page
      ? { url: page, label: source?.key === 'us-coops' ? 'Datums page' : 'Agency page' }
      : { url: source?.licenceUrl ?? '', label: 'Agency page' },
    // CHS: the short credit in the footer, the licence's full notice in the card body.
    credit:
      source?.key === 'ca-chs'
        ? `${source.attribution} · ${NOT_FOR_NAVIGATION}`
        : [source?.attribution, source?.disclaimer].filter(Boolean).join(' · '),
    ...(source?.key === 'ca-chs' ? { notice: source.disclaimer } : {}),
    ...(s.live ? { live: s.live } : {}),
    cdLabel,
  };
}
