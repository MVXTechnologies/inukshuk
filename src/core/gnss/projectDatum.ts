/**
 * The project datums the receiver extension offers (owner decision A4: a
 * user-chosen project datum, default WGS 84). Each is a frame, an epoch and
 * a height system Convert can plan to from a GNSS fix along validated
 * routes; whether it can from where the user stands is decided per fix by
 * `planFixOutput` (a refusal is shown with Convert's reason, e.g. a
 * Canadian datum outside Canada).
 */
import type { ProjectDatum } from './datum';

export interface ProjectDatumOption {
  id: string;
  /** "NAD83(CSRS) epoch 2010.0". */
  label: string;
  /** Where and why it is used. */
  note: string;
  datum: ProjectDatum;
}

const WGS84_OPTION: ProjectDatumOption = {
  id: 'wgs84',
  label: 'WGS 84',
  note: 'What the map, GPX files and most apps use · ellipsoidal heights',
  datum: { frame: 'wgs84', height: 'ell' },
};

export const PROJECT_DATUM_OPTIONS: readonly ProjectDatumOption[] = [
  WGS84_OPTION,
  {
    id: 'itrf2020',
    label: 'ITRF2020 · current epoch',
    note: 'The global reference frame, today · ellipsoidal heights',
    datum: { frame: 'itrf2020', epoch: 'observation', height: 'ell' },
  },
  {
    id: 'csrs-2010-cgvd2013',
    label: 'NAD83(CSRS) epoch 2010.0 · CGVD2013',
    note: 'Canada: federal and most provincial surveys · CGVD2013 (CGG2013a) heights',
    datum: { frame: 'csrs', epoch: 2010, height: 'cgvd2013a' },
  },
  {
    id: 'csrs-2010',
    label: 'NAD83(CSRS) epoch 2010.0',
    note: 'Canada · ellipsoidal heights',
    datum: { frame: 'csrs', epoch: 2010, height: 'ell' },
  },
  {
    id: 'csrs-1997',
    label: 'NAD83(CSRS) epoch 1997.0',
    note: 'Québec: the MRNF network and cadastre · ellipsoidal heights',
    datum: { frame: 'csrs', epoch: 1997, height: 'ell' },
  },
  {
    id: 'nad83-2011',
    label: 'NAD83(2011)',
    note: 'United States: NGS, state RTNs · ellipsoidal heights',
    datum: { frame: 'nad83-2011', height: 'ell' },
  },
];

export const DEFAULT_PROJECT_DATUM_ID = 'wgs84';

/** The option with this id; the default (WGS 84) for an unknown one. */
export function projectDatumOption(id: string | null | undefined): ProjectDatumOption {
  return PROJECT_DATUM_OPTIONS.find((o) => o.id === id) ?? WGS84_OPTION;
}

export function isProjectDatumId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_DATUM_OPTIONS.some((o) => o.id === id);
}
