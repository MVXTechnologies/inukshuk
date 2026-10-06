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
 * else rule, so a stray URL cannot read it — and every served URL also
 * carries a per-session secret ({@link servedBase}), so another app on the
 * device cannot read even the allowlisted folders.
 */
export const SERVED_DOCUMENT_PREFIXES: readonly string[] = [
  'maps',
  'offline-styles',
  '.rasterizer',
  // Picked photos staged for the resize worker, deleted once their copies
  // are made (#587). The kept copies under `photos/` stay unreachable.
  '.photo-inbox',
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
 * The per-session secret every served URL starts with (`/<secret>/maps/…`).
 *
 * The server listens on 127.0.0.1 only, but on Android any app holding the
 * INTERNET permission may connect to loopback, and a web page in a browser
 * on the phone can reach it through DNS rebinding. A port scan finds the
 * server in milliseconds; the secret is what keeps it from serving them
 * files: a URL without it is denied before any file is touched. It comes
 * from the native CSPRNG at the first start of a JS session and is kept
 * across restarts, so URLs already handed out stay valid. Only URL-, regex-
 * and config-safe characters, and at least 32 of them (a v4 UUID carries
 * 122 random bits), are accepted.
 */
export function isServerSecret(secret: string): boolean {
  return /^[A-Za-z0-9-]{32,64}$/.test(secret);
}

/** `http://127.0.0.1:<port>/<secret>`: the base every served URL is built on. */
export function servedBase(origin: string, secret: string): string {
  if (!isServerSecret(secret)) throw new Error('invalid loopback server secret');
  return `${origin.replace(/\/+$/, '')}/${secret}`;
}

/** A lighttpd string literal (backslashes and double quotes escaped). */
function lighttpdString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A lighttpd config fragment that serves the document directory under
 * `/<secret>/` only, and within it denies every URL outside `prefixes`.
 *
 * - `alias.url` maps `/<secret>/` onto `documentRoot`. A URL without the
 *   secret would fall through to the server's own document root, but every
 *   such URL is denied by the rule below.
 * - `url.access-deny = ( "" )` is mod_access's "deny everything" spelling;
 *   wrapped in a negated URL match it becomes an allowlist. mod_access and
 *   mod_alias are compiled into the static-server build but NOT in its
 *   default module list — without the `server.modules +=` line lighttpd logs
 *   "unknown config-key: url.access-deny (ignored)" and serves everything
 *   (seen on the first device run of #269).
 *
 * The pattern avoids backslash escapes on purpose — the `.` in `.rasterizer`
 * goes through a character class, and the secret needs no escaping (see
 * {@link isServerSecret}) — so it survives lighttpd's own string parsing.
 */
export function lighttpdAccessConfig(
  prefixes: readonly string[],
  secret: string,
  documentRoot: string,
): string {
  if (!isServerSecret(secret)) throw new Error('invalid loopback server secret');
  const alternatives = prefixes.map((p) => p.replace(/\./g, '[.]')).join('|');
  const root = documentRoot.endsWith('/') ? documentRoot : `${documentRoot}/`;
  return (
    `server.modules += ( "mod_access", "mod_alias" )\n` +
    `alias.url = ( ${lighttpdString(`/${secret}/`)} => ${lighttpdString(root)} )\n` +
    `$HTTP["url"] !~ "^/${secret}/(${alternatives})/" {\n  url.access-deny = ( "" )\n}`
  );
}
