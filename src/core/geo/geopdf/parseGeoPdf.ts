import type { GeoReference } from '@core/models';
import { extractAdobeGeo } from './adobeGeo';
import { extractLgiDict } from './lgidict';
import { collectPages, type PageInfo } from './pageTree';
import { type ByteSource, PdfDocument } from './pdfReader';

/** Result of parsing embedded georeferencing from a PDF. */
export interface GeoPdfParseResult {
  pageCount: number;
  /** One per georeferenced page found (may be empty). */
  georeferences: GeoReference[];
  warnings: string[];
}

/**
 * Parse embedded georeferencing from a PDF — either raw bytes in memory or a
 * random-access {@link ByteSource} (the import path: a 200 MB sheet is read a
 * few hundred KB at a time, #328). Never throws: any parse failure becomes a
 * warning and an empty/partial result.
 *
 * For each page we try Adobe ISO-32000 (/VP + /Measure /GEO) first, then OGC
 * LGIDict (/LGIDict). A page may yield multiple georeferences (e.g. several
 * viewports); all are returned.
 */
export function parseGeoPdf(input: Uint8Array | ByteSource): GeoPdfParseResult {
  const warnings: string[] = [];
  let pageCount = 0;
  const georeferences: GeoReference[] = [];

  let doc: PdfDocument;
  try {
    doc = PdfDocument.parse(input);
  } catch (e) {
    return {
      pageCount: 0,
      georeferences: [],
      warnings: [`PDF parse failed: ${(e as Error).message}`],
    };
  }
  warnings.push(...doc.warnings);

  let pages: PageInfo[];
  try {
    pages = collectPages(doc);
  } catch (e) {
    warnings.push(`page tree walk failed: ${(e as Error).message}`);
    pages = [];
  }
  pageCount = pages.length;

  for (const page of pages) {
    try {
      const adobe = extractAdobeGeo(doc, page, warnings);
      const lgi = extractLgiDict(doc, page, warnings);
      georeferences.push(...adobe, ...lgi);
    } catch (e) {
      warnings.push(`page ${page.index}: georeference extraction failed: ${(e as Error).message}`);
    }
  }

  if (georeferences.length === 0 && pageCount > 0) {
    warnings.push('no embedded georeferencing (VP/Measure GEO or LGIDict) found');
  }
  if (pageCount === 0) {
    warnings.push('no pages found — file may be malformed or not a PDF');
  }

  return { pageCount, georeferences, warnings };
}
