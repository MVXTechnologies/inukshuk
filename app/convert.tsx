import { ConvertScreen } from '@features/convert/ConvertScreen';
import { useLocalSearchParams } from 'expo-router';

/**
 * Convert. Opened from the map-tap chip, the survey-mark and tide-station
 * cards, the map-actions sheet, or a deep link:
 * `inukshuk://convert?from=csrs:geo&epoch=1997&a=46.851168&b=-71.238585&h=-3.127&fh=ell&to=csrs:mtm7&th=cgvd2013a`
 * (keys: `@core/convert/prefill` toParams/fromParams; junk is dropped).
 */
export default function ConvertRoute() {
  const params = useLocalSearchParams();
  // A new link while Convert is open (another mark, a deep link) starts a new request.
  return <ConvertScreen key={JSON.stringify(params)} params={params} />;
}
