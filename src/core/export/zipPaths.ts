/**
 * Zip entry-path helpers shared by the archive planners. Pure string work: no
 * file I/O, no platform deps.
 */

/**
 * Reduce a uri/path to a safe zip entry basename: last path segment, query and
 * fragment stripped, percent-escapes decoded, and anything outside
 * `[A-Za-z0-9._-]` replaced. Never returns an empty string.
 */
export function sanitizeEntryName(uriOrName: string): string {
  const lastSegment = uriOrName.split(/[?#]/)[0]?.split(/[/\\]/).pop() ?? '';
  let decoded = lastSegment;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    // Malformed escapes: keep the raw segment; it is sanitized below anyway.
  }
  const clean = decoded.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean || 'file';
}

/** Claim `path` in `taken`, suffixing `-2`, `-3`, … before the extension on collision. */
export function uniquePath(taken: Set<string>, path: string): string {
  if (!taken.has(path)) {
    taken.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}
