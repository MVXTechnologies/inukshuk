/**
 * Human/clipboard-friendly coordinate formatting.
 *
 * Three notations, because that is what the rest of the world hands you:
 * decimal degrees (what every mapping app's search box wants), degrees +
 * decimal minutes (marine/aviation, and what a GPS receiver shows by default)
 * and degrees/minutes/seconds (paper maps, land descriptions). All three round
 * trip through `parseLatLng`.
 */

/** Signed decimal degrees split into a hemisphere letter and a magnitude. */
function split(value: number, positive: string, negative: string): [string, number] {
  return [value < 0 ? negative : positive, Math.abs(value)];
}

/**
 * Five decimals ≈ 1.1 m at the equator — GPS-grade precision without noise —
 * and the "lat, lng" order pastes straight into every mapping app's search.
 */
export function formatLatLng(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/**
 * Degrees + decimal minutes, e.g. `46°48.834'N, 71°12.492'W`.
 *
 * The rounding CARRIES: 59.9999' rounds to 60.000', which must become the next
 * whole degree and 0.000', not the impossible "46°60.000'".
 */
export function formatLatLngDdm(latitude: number, longitude: number): string {
  return `${ddm(latitude, 'N', 'S')}, ${ddm(longitude, 'E', 'W')}`;
}

function ddm(value: number, positive: string, negative: string): string {
  const [hemi, magnitude] = split(value, positive, negative);
  let deg = Math.floor(magnitude);
  let minutes = Number(((magnitude - deg) * 60).toFixed(3));
  if (minutes >= 60) {
    minutes = 0;
    deg += 1;
  }
  return `${deg}°${minutes.toFixed(3).padStart(6, '0')}'${hemi}`;
}

/**
 * Degrees/minutes/seconds, e.g. `46°48'50.2"N, 71°12'29.5"W`. Same
 * carry-on-rounding care as {@link formatLatLngDdm}, one level deeper.
 */
export function formatLatLngDms(latitude: number, longitude: number): string {
  return `${dms(latitude, 'N', 'S')}, ${dms(longitude, 'E', 'W')}`;
}

function dms(value: number, positive: string, negative: string): string {
  const [hemi, magnitude] = split(value, positive, negative);
  let deg = Math.floor(magnitude);
  let min = Math.floor((magnitude - deg) * 60);
  let sec = Number((((magnitude - deg) * 60 - min) * 60).toFixed(1));
  if (sec >= 60) {
    sec = 0;
    min += 1;
  }
  if (min >= 60) {
    min = 0;
    deg += 1;
  }
  return `${deg}°${String(min).padStart(2, '0')}'${sec.toFixed(1).padStart(4, '0')}"${hemi}`;
}
