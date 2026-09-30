import { useMemo } from 'react';

/**
 * A GeoJSON object serialized once per identity (#465).
 *
 * maplibre-react-native's `<GeoJSONSource>` runs `JSON.stringify(data)` on
 * every render of the source when `data` is an object, and hands the native
 * side a new string each time — which re-parses and re-tiles the whole
 * source. Anything that re-renders the source (a filter or children change on
 * selection) therefore re-uploaded a whole-library source. A string `data` is
 * passed through as-is, and an unchanged string is not re-sent.
 */
export function useGeoJsonString(data: object | null | undefined): string | null {
  return useMemo(() => (data ? JSON.stringify(data) : null), [data]);
}
