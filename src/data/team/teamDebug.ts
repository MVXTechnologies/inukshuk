/**
 * Team mesh tracing for loopback builds only (`EXPO_PUBLIC_MESH_LOOPBACK=1`:
 * dev and E2E). The flag is inlined at build time, so a store build keeps an
 * empty function and none of the strings. The lines land in logcat
 * (`ReactNativeJS`) as `TEAMDBG …`, which is how a join stuck on
 * "Connecting to the team…" in E2E is traced to the phase it stalls in.
 */
const ON = process.env.EXPO_PUBLIC_MESH_LOOPBACK === '1';

export function teamDebug(...parts: unknown[]): void {
  if (!ON) return;
  console.log('TEAMDBG', ...parts);
}

/** A session event's name, for the trace (`{ type: 'closed', why }` → "closed(why)"). */
export function describeEvent(event: unknown): string {
  if (typeof event !== 'object' || event === null) return String(event);
  const e = event as { type?: unknown; why?: unknown };
  const type = typeof e.type === 'string' ? e.type : '?';
  return typeof e.why === 'string' ? `${type}(${e.why})` : type;
}
