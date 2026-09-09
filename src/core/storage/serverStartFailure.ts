/**
 * Turn a loopback-server start failure into a message that names the cause.
 *
 * The static-server library reports only "Native server exited with status
 * -1" (#276, #277): that is lighttpd's exit code, and the reason — a config
 * line it rejected, a module it could not load, a port it could not bind —
 * goes to its own error log. Appending the tail of that log to the error is
 * what makes the next auto-report diagnosable; without it the phone that
 * fails stays a mystery (the emulator and the owner's Samsung never fail).
 */

/** How much of the log we carry: enough for lighttpd's few config/bind lines. */
export const LOG_TAIL_LINES = 12;
export const LOG_TAIL_CHARS = 800;

/** The last {@link LOG_TAIL_LINES} non-empty lines, capped at {@link LOG_TAIL_CHARS}. */
export function logTail(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return null;
  const tail = lines.slice(-LOG_TAIL_LINES).join('\n');
  return tail.length > LOG_TAIL_CHARS ? tail.slice(tail.length - LOG_TAIL_CHARS) : tail;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/**
 * `attempts` is how many starts were tried (the caller retries once with a
 * fresh instance because the library forbids restarting a crashed one).
 */
export function describeServerStartFailure(
  err: unknown,
  tail: string | null,
  attempts: number,
): string {
  const head = `Loopback server failed to start after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${messageOf(err)}`;
  return tail === null
    ? `${head} (no lighttpd error log)`
    : `${head}\nlighttpd error log:\n${tail}`;
}
