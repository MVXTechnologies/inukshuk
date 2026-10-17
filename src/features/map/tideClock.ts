/** "16:52": the phone's clock (tide times on the map label and the graph). */
export function tideClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The phone's zone offset at `ms` (local − UTC), for the graph's clock ticks. */
export function tzOffsetMs(ms: number): number {
  return -new Date(ms).getTimezoneOffset() * 60_000;
}
