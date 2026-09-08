import { isAbsolutePath } from './documentPaths';

/**
 * Which parts of the document directory the in-app loopback file server may
 * hand out, and how a stored document-relative path becomes a URL on it.
 *
 * The server's root is the whole document directory (#269) because the files
 * it must serve — imported maps, the offline-map style documents and the
 * rasterizer page — live in sibling folders there. Everything else under
 * Documents (`library.json`, trails, photos, error reports) is the user's
 * data and has no business being reachable over HTTP, loopback or not; the
 * allowlist below is compiled into the server's config as a deny-everything-
 * else rule, so a stray URL cannot read it.
 */
export const SERVED_DOCUMENT_PREFIXES: readonly string[] = [
  'maps',
  'offline-styles',
  '.rasterizer',
];

/**
 * The URL a document-relative path is served at, or `null` when it cannot be
 * served: an absolute path (a `content://` intent uri, a cache file — nothing
 * under the server's root), a `..` segment, or a folder outside the allowlist.
 * Each segment is percent-encoded so a name with a space or `#` survives.
 */
export function servedFileUrl(origin: string, documentPath: string): string | null {
  if (documentPath === '' || isAbsolutePath(documentPath)) return null;
  const segments = documentPath.split('/').filter((s) => s !== '');
  const [root] = segments;
  if (root === undefined || segments.length < 2) return null;
  if (segments.some((s) => s === '..' || s === '.')) return null;
  if (!SERVED_DOCUMENT_PREFIXES.includes(root)) return null;
  return `${origin.replace(/\/+$/, '')}/${segments.map(encodeURIComponent).join('/')}`;
}

/**
 * A lighttpd config fragment that denies every URL outside `prefixes`.
 *
 * `url.access-deny = ( "" )` is mod_access's "deny everything" spelling; wrapped
 * in a negated URL match it becomes an allowlist. The pattern avoids backslash
 * escapes on purpose — the `.` in `.rasterizer` goes through a character class
 * — so it survives lighttpd's own string parsing unchanged.
 */
export function lighttpdAccessConfig(prefixes: readonly string[]): string {
  const alternatives = prefixes.map((p) => p.replace(/\./g, '[.]')).join('|');
  return `$HTTP["url"] !~ "^/(${alternatives})/" {\n  url.access-deny = ( "" )\n}`;
}
