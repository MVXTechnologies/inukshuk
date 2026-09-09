import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Regression guard for #247.
 *
 * iOS rotates the app data-container UUID on every app update, so an absolute
 * `file:///…/Application/<UUID>/Documents/tracks/x.gpx` written to
 * `library.json` by the build the user is updating FROM points at nothing
 * afterwards — the files survive, the index doesn't. Every persisted path is
 * therefore document-RELATIVE, resolved against `Paths.document` at read time.
 *
 * That invariant is easy to break by accident: one new `fileUri`/`photoUri`
 * field written straight through, and iOS users lose their library on the next
 * update all over again. This test reads the persistence layers' own sources
 * and fails if a `file://` literal appears anywhere outside the small set of
 * modules whose job is to translate between the two forms.
 *
 * The behavioural half of the guard lives in
 * `libraryStore.documentPaths.test.ts` and `recorderCheckpoint.test.ts`, which
 * assert that the documents actually handed to `writeIndex`/`writeJson`
 * contain no `file://` at any depth.
 */

const SRC = join(__dirname, '..');

/** Directories whose modules write to, or read from, persistent storage. */
const PERSISTENCE_DIRS = ['data', 'state'];

/**
 * Modules that legitimately name the `file://` scheme, because translating it
 * is precisely what they do. Keep this list SHORT — a new entry is a claim
 * that a module needs to speak in absolute uris, which for anything that
 * persists is the bug.
 */
const ALLOWED = new Set([
  // The one bridge between relative and absolute (#247).
  'core/storage/documentPaths.ts',
  // Binds that bridge to `Paths.document`; also the app's only File/Directory
  // caller, so it necessarily handles `file://` uris.
  'data/storage.ts',
  // MapLibre's offline pack API wants a bare filesystem path, not a uri, and
  // strips the scheme to get one. Nothing here is persisted by us.
  'data/offline.ts',
  // Test-only helper (never imported by the app): the mocked document dir.
  'data/storageTestMock.ts',
]);

/**
 * Drop comments so the scan sees code only — the models legitimately *describe*
 * the absolute `file://` uris they hold in memory, and documenting the
 * invariant must not trip the test that enforces it.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block and JSDoc comments
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** A string literal that OPENS with the `file://` scheme — a hard-coded uri. */
const FILE_URI_LITERAL = /['"`]file:\/\//;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sourceFiles(rel));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    out.push(rel);
  }
  return out;
}

describe('persisted paths are document-relative (#247)', () => {
  const files = [...PERSISTENCE_DIRS.flatMap(sourceFiles), 'core/storage/documentPaths.ts'];

  it('finds the persistence sources to scan', () => {
    // A silently empty scan would pass forever; assert the corpus is real.
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain('state/libraryStore.ts');
    expect(files).toContain('data/recorderCheckpoint.ts');
  });

  it('no module under src/data or src/state names the file:// scheme', () => {
    const offenders = files
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => FILE_URI_LITERAL.test(codeOnly(readFileSync(join(SRC, rel), 'utf8'))))
      .map((rel) => relative('.', rel));

    // If this fails: persist the document-relative path (`storage.toDocumentPath`)
    // and rebuild the uri at read time (`storage.resolveDocumentPath`) instead
    // of storing an absolute one. See `mapLibraryIndexPaths`.
    expect(offenders).toEqual([]);
  });

  it('the library index walker covers every persisted path field', () => {
    // `mapLibraryIndexPaths` is the single list of paths in `library.json`. If
    // a new `fileUri`/`photoUri` field is added to the models without being
    // added there, it is persisted absolute and goes stale on the next update.
    const walker = readFileSync(join(SRC, 'core/library/migrations.ts'), 'utf8');
    for (const field of ['maps', 'tracks', 'notes', 'waypoints']) {
      expect(walker).toContain(`export function mapLibraryIndexPaths`);
      expect(walker.slice(walker.indexOf('mapLibraryIndexPaths'))).toContain(field);
    }
  });
});
