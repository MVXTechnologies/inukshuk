/**
 * Index + packed-details datasets (pure routing; the R2 reads are in
 * index.ts). Each dataset is built monthly on the NAS as three objects:
 *
 *   {prefix}-v1.index.json          the index the app downloads once
 *   {prefix}-{version}.details.bin  every item's JSON, concatenated
 *   {prefix}-{version}.offsets.json {id: [offset, length]}
 *
 * and served as /{prefix}/v1/index.json and /{prefix}/v1/d/{version}/{id}.json.
 * The index names the version and is uploaded last, so a refresh switches
 * over atomically; a detail URL never changes once published.
 *
 *   trails    long-distance trails (#467, ../nas/trails.sh), ids `r123`
 *   climbing  climbing crags (../nas/climbing.sh), ids `ob-…`, `osm-n123`, `c2c-123`
 */
export type DetailDataset = 'trails' | 'climbing';

export type DetailRoute =
  | { dataset: DetailDataset; kind: 'index' }
  | { dataset: DetailDataset; kind: 'detail'; version: string; id: string };

const ID_PATTERN: Record<DetailDataset, RegExp> = {
  trails: /^r\d{1,12}$/,
  climbing: /^(?:ob-[0-9a-f]{16}|osm-[nwr]\d{1,12}|c2c-\d{1,10})$/,
};

const PATH =
  /^\/(trails|climbing)\/v1\/(?:index\.json|d\/([a-z0-9_-]{1,40})\/([a-z0-9-]{1,40})\.json)$/;

export function detailRoute(pathname: string): DetailRoute | null {
  const m = PATH.exec(pathname);
  if (m === null) return null;
  const dataset = m[1] as DetailDataset;
  const [, , version, id] = m;
  if (version === undefined || id === undefined) {
    return pathname.endsWith('/index.json') ? { dataset, kind: 'index' } : null;
  }
  if (!ID_PATTERN[dataset].test(id)) return null;
  return { dataset, kind: 'detail', version, id };
}

/** R2 object keys for a dataset. */
export function detailKeys(dataset: DetailDataset, version = '') {
  return {
    index: `${dataset}-v1.index.json`,
    details: `${dataset}-${version}.details.bin`,
    offsets: `${dataset}-${version}.offsets.json`,
  };
}
