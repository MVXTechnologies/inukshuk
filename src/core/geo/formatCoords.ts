/**
 * Human/clipboard-friendly coordinate formatting for the waypoint viewer.
 * Five decimals ≈ 1.1 m at the equator — GPS-grade precision without noise —
 * and the "lat, lng" order pastes straight into every mapping app's search.
 */
export function formatLatLng(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}
