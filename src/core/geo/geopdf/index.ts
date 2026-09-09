/**
 * geopdf — extract georeferencing from georeferenced PDFs and sidecar files,
 * producing the shared `GeoReference` type with WGS84 (EPSG:4326) corners in
 * longitude/latitude order.
 *
 * Pure TypeScript: no react-native/expo imports, runs in Node (Jest) and the
 * RN JS runtime. Depends only on `proj4` and `fflate`.
 */
export { parseGeoPdf, type GeoPdfParseResult } from './parseGeoPdf';
export { type ByteSource, memoryByteSource } from './pdfReader';
export { parseWorldFile } from './worldFile';
export { parseAuxXml } from './auxXml';
