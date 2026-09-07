/**
 * Document-relative path helpers (#247).
 *
 * iOS gives each install of an app a fresh data-container UUID, and it rotates
 * that UUID on **app updates** — so an absolute
 * `file:///…/Containers/Data/Application/<UUID>/Documents/tracks/x.gpx`
 * persisted by 1.5.0 points at nothing after the user installs 1.5.1, even
 * though the file itself was carried over intact. Every trail, map and photo
 * looked lost on the first App Store update.
 *
 * The fix is to persist **document-relative** paths (`tracks/<id>.gpx`) and
 * rebuild the absolute uri against the *current* document directory at read
 * time. These are the pure string halves of that contract; `@data/storage`
 * binds them to `Paths.document`.
 */

/** A `scheme://…` uri, or a bare POSIX absolute path. */
const ABSOLUTE_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\/)/;

/**
 * The iOS container's document directory segment. It is the only stable
 * landmark in a rotated path: the UUID above it is exactly what changed, so a
 * migration cannot match on the prefix it used to have.
 */
const DOCUMENTS_MARKER = '/Documents/';

/** Is this a path we must NOT join onto the document directory? */
export function isAbsolutePath(value: string): boolean {
  return ABSOLUTE_RE.test(value);
}

function withTrailingSlash(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

/**
 * Reduce a stored path to its document-relative form.
 *
 * - Already relative (or empty) — returned untouched, so this is **idempotent**
 *   and safe to run on every hydrate.
 * - Under `documentDir` (when one is supplied) — the prefix is stripped. This
 *   is the same-container and Android case.
 * - Under some *other* container's `/Documents/` — everything up to and
 *   including the FIRST `/Documents/` is stripped. This is the rotated-UUID
 *   case the bug is about. (First, not last: a file whose own name contains
 *   "Documents" must keep its subdirectory.)
 * - Absolute but not under any document directory — returned untouched. It is
 *   not ours to rewrite; callers log it rather than guess.
 */
export function toDocumentRelativePath(value: string, documentDir?: string): string {
  if (value === '' || !isAbsolutePath(value)) return value;

  if (documentDir !== undefined && documentDir !== '') {
    const prefix = withTrailingSlash(documentDir);
    if (value.startsWith(prefix)) {
      const rest = value.slice(prefix.length).replace(/^\/+/, '');
      if (rest !== '') return rest;
    }
  }

  const marker = value.indexOf(DOCUMENTS_MARKER);
  if (marker !== -1) {
    const rest = value.slice(marker + DOCUMENTS_MARKER.length).replace(/^\/+/, '');
    if (rest !== '') return rest;
  }

  return value;
}

/**
 * Rebuild an absolute uri for a document-relative path against `documentDir`.
 * A value that is already absolute (a `content://` intent uri, a cache file, a
 * foreign path the migration left alone) passes straight through, so callers
 * can resolve unconditionally.
 */
export function joinDocumentPath(documentDir: string, value: string): string {
  if (value === '' || isAbsolutePath(value)) return value;
  return `${withTrailingSlash(documentDir)}${value.replace(/^\/+/, '')}`;
}
