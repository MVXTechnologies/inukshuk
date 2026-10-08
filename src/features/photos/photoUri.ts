import { resolveDocumentPath } from '@data/storage';

/**
 * The `file://` uri to display a photo file from (#587). Trail photo paths
 * are document-relative (`photos/<trackId>/<id>.jpg`, resolved against the
 * current container at every use, #247); a note photo seen through
 * `noteToPhoto` carries the note's absolute uri, which passes through.
 */
export function photoFileUri(path: string): string {
  return resolveDocumentPath(path);
}
