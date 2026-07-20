import type { MapDocument } from '@core/models';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { mapDocumentFromStoredPdf } from '../../library/importMap';
import {
  composeMapPdf,
  type ComposeHandle,
  type ComposeInput,
  type ComposePhase,
} from './composeMapPdf';

/**
 * Compose a made map and land it in the Library through the standard PDF
 * import path — a made map IS an imported PDF (activate/rename/folders/delete
 * all behave identically), and re-parsing our own file with `parseGeoPdf`
 * doubles as an end-to-end georeferencing check on every single make.
 */
export async function makeMap(
  input: ComposeInput,
  onProgress: (phase: ComposePhase, frac: number) => void,
  handle: ComposeHandle,
): Promise<MapDocument> {
  const bytes = await composeMapPdf(input, onProgress, handle);
  const id = storage.newId();
  const fileUri = storage.writeMapPdfBytes(id, bytes);
  let doc: MapDocument;
  try {
    doc = await mapDocumentFromStoredPdf(id, fileUri, input.options.name);
  } catch (err) {
    // Failing to re-parse a PDF we just wrote is a bug in the composer or
    // writer, not a user error — surface it through error reporting with the
    // recipe so it can be reproduced.
    reportError(err, `made-map-import ${JSON.stringify(input.options)}`);
    throw err;
  }
  if (doc.georeferences.length === 0) {
    reportError(
      new Error('made map parsed with no georeference'),
      `made-map-georef ${JSON.stringify(input.options)}`,
    );
  }
  useLibraryStore.getState().addMap(doc);
  return doc;
}
