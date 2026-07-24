/**
 * Internal value types for the focused PDF object model. These mirror the small
 * subset of the PDF spec we need: numbers, strings, names, booleans, null,
 * arrays, dictionaries, indirect references and streams.
 */

/** An indirect reference like `12 0 R`. */
export interface PdfRef {
  kind: 'ref';
  num: number;
  gen: number;
}

/** A PDF name like `/GEO`. Stored without the leading slash. */
export interface PdfName {
  kind: 'name';
  name: string;
}

/** A PDF stream: its dict plus the raw (still-encoded) byte payload. */
export interface PdfStream {
  kind: 'stream';
  dict: PdfDict;
  raw: Uint8Array;
}

export type PdfDict = { kind: 'dict'; entries: Map<string, PdfValue> };
export type PdfArray = PdfValue[];

export type PdfValue =
  number | string | boolean | null | PdfName | PdfRef | PdfArray | PdfDict | PdfStream;

// These guards accept `PdfValue | undefined` so callers can pass the result of a
// Map.get()/index access directly. They already reject `undefined` at runtime via
// the object/null checks (and Array.isArray(undefined) === false).
export const isRef = (v: PdfValue | undefined): v is PdfRef =>
  typeof v === 'object' && v !== null && (v as PdfRef).kind === 'ref';
export const isName = (v: PdfValue | undefined): v is PdfName =>
  typeof v === 'object' && v !== null && (v as PdfName).kind === 'name';
export const isDict = (v: PdfValue | undefined): v is PdfDict =>
  typeof v === 'object' && v !== null && (v as PdfDict).kind === 'dict';
export const isStream = (v: PdfValue | undefined): v is PdfStream =>
  typeof v === 'object' && v !== null && (v as PdfStream).kind === 'stream';
export const isArray = (v: PdfValue | undefined): v is PdfArray => Array.isArray(v);
