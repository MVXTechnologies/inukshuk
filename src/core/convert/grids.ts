/**
 * The PROJ-data grids the Convert tool may use, with their agency, licence
 * and version label (the accuracy panel names every grid it used).
 *
 * Only two are bundled with the app (CONVERT.md §3): EGM96 (the GPS receiver
 * default) and the NAD83(CSRS) v7 velocity grid (epoch math anywhere in
 * Canada). Everything else comes in a grid pack (`@data/projGrids`), and a
 * conversion whose grid is not on the device is refused, never approximated.
 * The CC-BY-SA agencies (br_ibge, de_geosn, de_lgl_bw, de_hvbg, hu_bme) are
 * deliberately absent.
 */
import type { GridRef } from './types';

const NRCAN = { agency: 'NRCan', licence: 'OGL-Canada' };
const NOAA = { agency: 'NOAA NGS', licence: 'Public domain' };
const NGA = { agency: 'NGA', licence: 'Public domain' };
const OS = { agency: 'Ordnance Survey', licence: 'BSD-2-Clause' };
const IGN = { agency: 'IGN France', licence: 'Etalab 2.0' };
const SWISSTOPO = { agency: 'swisstopo', licence: 'CC0' };
const KV = { agency: 'Kartverket', licence: 'CC BY 4.0' };
const NSGI = { agency: 'NSGI', licence: 'CC BY 4.0' };

function g(
  file: string,
  label: string,
  src: { agency: string; licence: string },
  bundled = false,
): GridRef {
  return { file, label, bundled, ...src };
}

export const GRIDS = {
  egm96: g('us_nga_egm96_15.tif', 'EGM96 15′ (NGA)', NGA, true),
  vel7: g('ca_nrc_NAD83v70VG.tif', 'NAD83(CSRS) velocity grid v7 (NRCan)', NRCAN, true),
  egm08: g('us_nga_egm08_25.tif', 'EGM2008 2.5′ (NGA)', NGA),
  cgg2013a: g('ca_nrc_CGG2013an83.tif', 'CGG2013a (NRCan)', NRCAN),
  cgg2013: g('ca_nrc_CGG2013n83.tif', 'CGG2013 (NRCan)', NRCAN),
  ht2_1997: g('ca_nrc_HT2_1997.tif', 'HTv2.0 1997 (NRCan)', NRCAN),
  ht2_2002: g('ca_nrc_HT2_2002v70.tif', 'HTv2.0 2002 v70 (NRCan)', NRCAN),
  ht2_2010: g('ca_nrc_HT2_2010v70.tif', 'HTv2.0 2010 v70 (NRCan)', NRCAN),
  ntv2_0: g('ca_nrc_ntv2_0.tif', 'NTv2.0 national (NRCan)', NRCAN),
  na27scrs: g('ca_nrc_NA27SCRS.tif', 'QUE27-98 / NA27SCRS (NRCan)', NRCAN),
  na83scrs: g('ca_nrc_NA83SCRS.tif', 'NAD83-98 / NA83SCRS (NRCan)', NRCAN),
  on27: g('ca_nrc_ON27CSv1.tif', 'ON27CSv1 (NRCan)', NRCAN),
  sk27: g('ca_nrc_SK27-98.tif', 'SK27-98 (NRCan)', NRCAN),
  nb27: g('ca_nrc_NB2783v2.tif', 'NB2783v2 (NRCan)', NRCAN),
  bc27: g('ca_nrc_BC_27_05.tif', 'BC_27_05 (NRCan)', NRCAN),
  geoid18: g('us_noaa_g2018u0.tif', 'GEOID18 CONUS (NOAA)', NOAA),
  n5_2007_2011: g(
    'us_noaa_nadcon5_nad83_2007_nad83_2011_conus.tif',
    'NADCON5 NSRS2007→2011 (NOAA)',
    NOAA,
  ),
  n5_fbn_2007: g(
    'us_noaa_nadcon5_nad83_fbn_nad83_2007_conus.tif',
    'NADCON5 FBN→NSRS2007 (NOAA)',
    NOAA,
  ),
  n5_harn_fbn: g('us_noaa_nadcon5_nad83_harn_nad83_fbn_conus.tif', 'NADCON5 HARN→FBN (NOAA)', NOAA),
  n5_1986_harn: g(
    'us_noaa_nadcon5_nad83_1986_nad83_harn_conus.tif',
    'NADCON5 1986→HARN (NOAA)',
    NOAA,
  ),
  n5_27_1986: g('us_noaa_nadcon5_nad27_nad83_1986_conus.tif', 'NADCON5 NAD27→1986 (NOAA)', NOAA),
  ostn15: g('uk_os_OSTN15_NTv2_OSGBtoETRS.tif', 'OSTN15 NTv2 (OS)', OS),
  osgm15: g('uk_os_OSGM15_GB.tif', 'OSGM15 GB (OS)', OS),
  osgm15ni: g('uk_os_OSGM15_Belfast.tif', 'OSGM15 Belfast (OS)', OS),
  raf20: g('fr_ign_RAF20.tif', 'RAF20 (IGN)', IGN),
  chLhn95: g('ch_swisstopo_chgeo2004_ETRS89_LHN95.tif', 'CHGeo2004 → LHN95 (swisstopo)', SWISSTOPO),
  chLn02: g(
    'ch_swisstopo_chgeo2004_ETRS89_LN02.tif',
    'CHGeo2004 HTRANS → LN02 (swisstopo)',
    SWISSTOPO,
  ),
  nn2000: g('no_kv_HREF2018B_NN2000_EUREF89.tif', 'HREF2018B (Kartverket)', KV),
  noCd: g('no_kv_CD_above_Ell_ETRS89_v2023b.tif', 'Chart datum Norway v2023b (Kartverket)', KV),
  nlgeo: g('nl_nsgi_nlgeo2018.tif', 'NLGEO2018 (NSGI)', NSGI),
  nllat: g('nl_nsgi_nllat2018.tif', 'NLLAT2018 (NSGI)', NSGI),
  rdtrans: g('nl_nsgi_rdtrans2018.tif', 'RDNAPTRANS2018 rdtrans2018 (NSGI)', NSGI),
} as const satisfies Record<string, GridRef>;

export type GridKey = keyof typeof GRIDS;

export const BUNDLED_GRIDS: readonly string[] = Object.values(GRIDS)
  .filter((x) => x.bundled)
  .map((x) => x.file);

export function gridByFile(file: string): GridRef | undefined {
  return Object.values(GRIDS).find((x) => x.file === file);
}
