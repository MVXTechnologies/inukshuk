/**
 * Convert's licence obligations (CONVERT §2), in the app's credits roll:
 * PROJ (MIT), libtiff and SQLite, the EPSG Dataset's terms (acknowledge IOGP
 * and point every user to the terms; never attribute modified data to EPSG),
 * and each grid agency's licence. The CC-BY-SA grids are not used at all.
 */
import { GRIDS } from './grids';

export const EPSG_TERMS_URL = 'https://epsg.org/terms-of-use.html';

function gridAgencies(): string {
  const seen = new Map<string, string>();
  for (const g of Object.values(GRIDS)) seen.set(g.agency, g.licence);
  return [...seen].map(([a, l]) => `${a} (${l})`).join(', ');
}

export const CONVERT_CREDITS = [
  'Convert: PROJ 9.8.1 (MIT, © Frank Warmerdam, Even Rouault and contributors)',
  'libtiff (© Sam Leffler, Silicon Graphics)',
  'SQLite (public domain)',
  `EPSG Geodetic Parameter Dataset, owned by IOGP — use is subject to its terms of use, ${EPSG_TERMS_URL}`,
  `Convert grids: ${gridAgencies()}; Ordnance Survey grids © Crown copyright`,
].join(' · ');
