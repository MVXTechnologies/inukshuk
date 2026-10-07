import type { ErrorReport } from './types';

/**
 * Privacy scrubbing for error reports, applied as a report leaves the device.
 *
 * Reports are filed as issues in a PUBLIC GitHub repository, and the privacy
 * policy (docs/privacy/index.html § Error reports) promises they carry "no
 * location, no map or trail content, and nothing that identifies you". The
 * raw material does not keep that promise by itself: native errors quote
 * absolute paths (on iOS they include the app container's UUID, and the file
 * name is the user's own name for their map or trail), messages quote map and
 * trail names, and a few diagnostics print coordinates. This strips:
 *
 * - URIs: the path of any `scheme://…` becomes `<path>`, keeping the scheme,
 *   the host (which provider failed matters; it is not personal) and the file
 *   extension (`.pdf` vs `.gpx` matters; the name does not). Query strings go
 *   with the path — they can hold coordinates or an OAuth code.
 * - Absolute paths (two or more segments), the same way: `<path>.pdf`.
 * - UUIDs (iOS container and bundle ids), as `<uuid>`.
 * - Quoted text, as `<str>`: typographic quotes, backticks and double quotes
 *   always; single quotes unless they hold a bare identifier or property path
 *   (`Cannot read property 'foo' of undefined` is the engine talking, and
 *   `foo` is what makes the report fixable). A double-quoted JSON key
 *   (`"name":`) stays, its value does not.
 * - Coordinates, as `<coord>`: a pair of decimals with 4+ places each (the
 *   ~10 m precision that points at a place; projected metres too), and any
 *   number labelled lat, lon, lng, latitude or longitude.
 *
 * Stack frames keep their function names and `:line:column`; only the bundle
 * path in front of them goes. Pure and idempotent.
 */

const PATH = '<path>';

/** Characters that end a path or URI in running text. */
const STOP = `\\s'"\`<>()\\[\\]{},;`;

/**
 * `<path>` plus what is worth keeping of the last segment: its extension and
 * any `:line:column` a stack frame appended.
 */
function placeholderFor(path: string): string {
  const last = path.split(/[?#]/, 1)[0]?.split('/').pop() ?? '';
  const position = /(?::\d+)+$/.exec(last)?.[0] ?? '';
  const name = last.slice(0, last.length - position.length);
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';
  return `${PATH}${extension}${position}`;
}

const URI = new RegExp(`\\b([a-z][a-z0-9+.-]*):\\/\\/([^/${STOP}]*)(\\/[^${STOP}]*)?`, 'gi');
const SEGMENT = `[^/${STOP}]+`;
// A file name may hold spaces ("My hike.gpx"): up to five words, but only
// when they end in an extension; otherwise the name stops at the space.
const LAST_SEGMENT = `(?:${SEGMENT}(?: ${SEGMENT}){1,4}\\.[A-Za-z0-9]{1,8}(?=$|[${STOP}:])|[^/${STOP}]*)`;
// Preceded by the start or a separator, so `km/h` and `1/2` are left alone.
const ABSOLUTE_PATH = new RegExp(
  `(^|[\\s=:(\\[{,'"\`])(\\/(?:${SEGMENT}\\/)+${LAST_SEGMENT})`,
  'g',
);
// Document-relative photo paths (#587): `photos/<trackId>/<id>.jpg` and the
// resize inbox, as data-layer errors quote them. Ids are random, but a photo
// path says which trail a report is about; it goes like any other path.
const PHOTO_PATH = new RegExp(
  `(^|[\\s=:(\\[{,'"\`])(\\.photo-inbox\\/${LAST_SEGMENT}|photos\\/(?:${SEGMENT}\\/)+${LAST_SEGMENT}|photos\\/${SEGMENT}\\.[A-Za-z0-9]{1,8}(?=$|[${STOP}:]))`,
  'g',
);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TYPOGRAPHIC = /“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»|`[^`\n]*`/g;
const DOUBLE_QUOTED = /"(?:[^"\\\n]|\\.)*"/g;
// An opening quote after a separator and a closing one before one, so the
// apostrophes in "couldn't" or "it's" never pair up into a "string".
const SINGLE_QUOTED = /(^|[\s(\[{=:,])'([^'\n]*)'(?=$|[\s)\]},.;:!?])/g;
const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
// Up to 7 integer digits: projected coordinates (UTM metres) place a map too.
const COORD_PAIR = /-?\b\d{1,7}\.\d{4,}\s*[,;/ ]\s*-?\d{1,7}\.\d{4,}\b/g;
const LABELLED_COORD = /\b(lat|lon|lng|latitude|longitude)("?\s*[:=]\s*)-?\d{1,3}(?:\.\d+)?\b/gi;

/** Scrub one piece of report text (a message, a stack, a breadcrumb…). */
export function scrubText(text: string): string {
  return text
    .replace(URI, (_m, scheme: string, host: string, path: string | undefined) =>
      path === undefined || path === '/'
        ? `${scheme}://${host}${path ?? ''}`
        : `${scheme}://${host}/${placeholderFor(path)}`,
    )
    .replace(ABSOLUTE_PATH, (_m, lead: string, path: string) => `${lead}${placeholderFor(path)}`)
    .replace(PHOTO_PATH, (_m, lead: string, path: string) => `${lead}${placeholderFor(path)}`)
    .replace(UUID, '<uuid>')
    .replace(TYPOGRAPHIC, '<str>')
    .replace(DOUBLE_QUOTED, (quoted: string, offset: number, whole: string) =>
      // A JSON key is code, not data: keep `"name":` readable.
      /^"[A-Za-z_$][\w$]*"$/.test(quoted) && /^\s*:/.test(whole.slice(offset + quoted.length))
        ? quoted
        : '<str>',
    )
    .replace(SINGLE_QUOTED, (quoted: string, lead: string, inner: string) =>
      IDENTIFIER_PATH.test(inner) && inner.length <= 64 ? quoted : `${lead}<str>`,
    )
    .replace(COORD_PAIR, '<coord>')
    .replace(
      LABELLED_COORD,
      (_m, label: string, separator: string) => `${label}${separator}<coord>`,
    );
}

/**
 * The report with every free-text field scrubbed. The fingerprint (already
 * computed from normalized text, and the dedupe key for the issue) and the
 * environment (versions, OS, device model) are left as they are.
 */
export function scrubReport(report: ErrorReport): ErrorReport {
  return {
    ...report,
    message: scrubText(report.message),
    ...(report.stack !== undefined ? { stack: scrubText(report.stack) } : {}),
    ...(report.componentStack !== undefined
      ? { componentStack: scrubText(report.componentStack) }
      : {}),
    ...(report.context !== undefined ? { context: scrubText(report.context) } : {}),
    breadcrumbs: report.breadcrumbs.map(scrubText),
  };
}
