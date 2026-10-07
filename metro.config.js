// Default Expo Metro config. Path aliases declared in tsconfig.json are read
// automatically by Expo's Metro resolver, so no extra wiring is needed here.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Treat the bundled pdf.js builds (`assets/pdfjs/*.pdfjs`) as binary assets so
// `require()` returns an asset module that expo-asset can resolve to a local
// file URI at runtime. We use a custom `.pdfjs` extension (rather than `.js`)
// so Metro never tries to parse these large minified ES-module bundles (or the
// wasm decoders) as source.
// See src/features/map/PdfRasterizer.README.md for the offline-bundling design.
config.resolver.assetExts = [...config.resolver.assetExts, 'pdfjs'];

module.exports = config;
