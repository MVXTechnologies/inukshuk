/**
 * Error fingerprinting: collapse "the same bug" into one stable id so repeat
 * occurrences dedupe into a single GitHub issue instead of filing duplicates.
 *
 * The fingerprint hashes the *normalized* message plus the top stack frames'
 * function names. Everything build-specific is stripped first: Hermes bundle
 * byte offsets, line:column numbers, file paths/URLs, hex addresses and
 * numeric ids all change between builds (or between occurrences) while the
 * underlying bug stays the same.
 */

/** How many stack frames participate in the fingerprint. */
const FINGERPRINT_FRAMES = 5;

/**
 * Normalize an error message for fingerprinting: volatile fragments (numbers,
 * hex ids, quoted values, URIs) are replaced with placeholders so two
 * occurrences of the same failure hash identically.
 */
export function normalizeMessage(message: string): string {
  return (
    message
      .replace(/(file|content|https?):\/\/\S+/gi, '<uri>')
      // The app's own file ids (nanoid(12): maps/<id>.pdf, <id>.gpx, …): one
      // failing map must not open one issue per file (#358–#419 were one bug
      // filed 20 times). Mixed-case, so ordinary words are left alone.
      .replace(
        // No lookbehind: the boundary is captured and put back.
        /(^|[^\w-])(?=[\w-]{0,11}[A-Z])(?=[\w-]{0,11}[a-z0-9])[\w-]{12}(?=\.[a-z0-9]{2,5}\b)/g,
        '$1<id>',
      )
      .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '<str>')
      .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
      .replace(/\d+(\.\d+)?/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  );
}

/**
 * Extract the function names of the top stack frames, normalized. Handles both
 * V8-style frames (`at fn (file:1:2)`) and Hermes/JSC-style frames
 * (`fn@file:1:2` or `at fn (address at bundle:1:234)`). Frames with no usable
 * name become `<anonymous>`; location info is discarded entirely (Hermes byte
 * offsets differ per build).
 */
export function normalizeStackFrames(stack: string, maxFrames = FINGERPRINT_FRAMES): string[] {
  const frames: string[] = [];
  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let name: string | undefined;
    // V8 / Hermes "at" frames: `at fnName (...)` or `at file:1:2`.
    const atMatch = /^at\s+([^\s(]+)/.exec(line);
    if (atMatch) {
      name = atMatch[1];
      // `at http://.../bundle:1:2` — a location, not a name.
      if (name !== undefined && /[:/]/.test(name)) name = '<anonymous>';
    } else {
      // JSC/Hermes `fnName@file:line:col` frames.
      const jscMatch = /^([^@\s]*)@/.exec(line);
      if (jscMatch) name = jscMatch[1] === '' ? '<anonymous>' : jscMatch[1];
    }
    if (name === undefined) continue; // message line or unrecognized noise
    frames.push(name);
    if (frames.length >= maxFrames) break;
  }
  return frames;
}

/** FNV-1a 32-bit hash, rendered as 8 hex chars. Stable across platforms. */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps the math in 32-bit ints).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Compute the stable fingerprint for an error: 8 hex chars over the normalized
 * message and the top stack-frame names.
 */
export function fingerprintError(message: string, stack?: string): string {
  const parts = [normalizeMessage(message)];
  if (stack !== undefined) parts.push(...normalizeStackFrames(stack));
  return fnv1a32(parts.join('\x00'));
}

/**
 * The machine-readable marker embedded in issue titles/bodies so repeat
 * occurrences can find their existing issue: `[auto-report:<fingerprint>]`.
 */
export function errorMarker(fingerprint: string): string {
  return `[auto-report:${fingerprint}]`;
}
