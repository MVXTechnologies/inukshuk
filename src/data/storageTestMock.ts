import { joinDocumentPath, toDocumentRelativePath } from '@core/storage/documentPaths';

/**
 * Test-only helper (like `@core/geo/geopdf/testUtils`) — never imported by the
 * app.
 *
 * Suites that `jest.mock('@data/storage', …)` stub only the handful of
 * functions they exercise, so they miss the document-path bridge (#247) that
 * `libraryStore` and `recorderCheckpoint` now go through on every persist and
 * hydrate. Spreading {@link documentPathMocks} into such a factory supplies a
 * working bridge rooted at {@link MOCK_DOCUMENT_DIR}, using the same pure
 * helpers the real module does — so a suite asserting on persisted paths sees
 * the production translation, not a hand-rolled approximation.
 */

/** The document directory the mocked storage resolves against. */
export const MOCK_DOCUMENT_DIR = 'file:///doc';

/** The `@data/storage` document-path exports, bound to {@link MOCK_DOCUMENT_DIR}. */
export function documentPathMocks(): {
  documentDirUri: () => string;
  resolveDocumentPath: (pathOrUri: string) => string;
  toDocumentPath: (pathOrUri: string) => string;
} {
  return {
    documentDirUri: () => MOCK_DOCUMENT_DIR,
    resolveDocumentPath: (pathOrUri) => joinDocumentPath(MOCK_DOCUMENT_DIR, pathOrUri),
    toDocumentPath: (pathOrUri) => toDocumentRelativePath(pathOrUri, MOCK_DOCUMENT_DIR),
  };
}
