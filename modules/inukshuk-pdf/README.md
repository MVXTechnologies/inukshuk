# Inukshuk native PDF detail renderer

Local Expo SDK 56 module, autolinked as `InukshukPdf` on Android and iOS. Android
uses API 21 `PdfRenderer` (the app's minSdk is 24); iOS uses a deliberately narrow
ImageIO JPEG crop path. Neither adds a third-party rendering dependency.

`renderCrop({fileUri, pageIndex, pageWidthPt, pageHeightPt, crop: {x0, y0, x1, y1}, targetWidthPx})`
returns a promise of `{fileUri, widthPx, heightPx, pageWidthPt, pageHeightPt, pageCount, loadMs, renderMs}`.
The result URI is a PNG in app cache `overlays/pdf-detail-native-UUID.png`.
Android `renderMs` includes bitmap allocation, native rendering and PNG
encoding/writing. iOS `renderMs` measures the bounded draw and PNG publication;
its preparation and context allocation are included in `loadMs`.

## Android

The caller must first verify with PDF.js that the page has rotation 0, UserUnit 1,
and a zero-origin visible page box matching the georeference dimensions.
PdfRenderer does not expose those metadata fields. The native side validates finite
crop coordinates, positive dimensions, integer page index, actual page dimensions
(with less than one point of integer-rounding tolerance), and private file paths.
Fractional verified page dimensions remain authoritative for crop geometry.

Only canonical `file:` paths inside the application's `filesDir` or `cacheDir` are
accepted. URI hosts, query strings, fragments, non-file schemes, directories,
symlink escapes and unreadable files are rejected. Output is initialized white,
limited to 3072 pixels per edge and 3 Mi pixels, encoded directly to a temporary
file and renamed after encoding succeeds. The white-initialized bitmap is marked
opaque so PNG encoding omits its redundant alpha channel. On the API 35 emulator,
the exact 1896×1659 Eco crop encoded in a median 504 ms instead of 1010 ms and used
6.48 MB instead of 7.31 MB; decoded RGB pixels were identical. This changes neither
resolution nor decoded bitmap memory.

Pages, renderer/descriptor, streams and
bitmaps are closed/recycled on success and failure. Partial output is deleted.

A process-wide admission gate rejects concurrent work with `E_PDF_BUSY`; a dedicated
serial worker never accumulates accepted rendering jobs or bitmaps. Synchronous
PdfRenderer cannot be hard-cancelled. Callers must keep their render slot occupied
until the native promise settles, then delete obsolete result files. Module teardown
marks ongoing work obsolete and deletes its completed output. Generic rendering,
validation and I/O failures reject with `E_PDF_RENDER`; absent context rejects with
`E_PDF_CONTEXT`.

## iOS

The Apple module supports only a verified single opaque baseline, interleaved
8-bit RGB JPEG paint. It checks page geometry and image placement independently,
then lazily crops the embedded JPEG with ImageIO before drawing a bounded output.
It does not draw the full PDF page with CoreGraphics. Text, paths, clipping, forms,
masks, blending, annotations, progressive or separate-component JPEG scans, and
other unsupported layouts return `E_PDF_UNSUPPORTED` for PDF.js fallback.

Input must resolve to a regular file inside private Documents or Caches storage.
Source JPEG data is limited to 64 MiB and source edges to 20,000 pixels. A source
crop of up to 16 Mi pixels is cropped lazily at full resolution; a larger one — the
whole 181 MP Eco page at overview zoom (#331) — is decoded by ImageIO at the JPEG
DCT reduction (1/2, 1/4 or 1/8) that fits that same budget and still carries the
output resolution, so memory follows the reduced frame and the page is never
refused into PDF.js, which cannot survive it on a phone. The opaque PNG output has
the same 3072-pixel edge and 3 Mi-pixel limits as Android. A process-wide gate and serial worker retain ownership
until native work and its autorelease pool finish; obsolete output is deleted.
See [the iOS implementation notes](ios/README.md) for recognition limits, host tests,
and the measured simulator memory/performance evidence.

## Provider and tile ownership

PDF.js verifies eligible page geometry before the first native crop. Successful
native geometry is cached in a 16-entry LRU keyed by file URI, revision, page,
dimensions and source. Subsequent crops can bypass PDF.js. Failure or timeout
invalidates that entry. `E_PDF_UNSUPPORTED` retries the same request once with
native handoff disabled; other native errors leave the overview available.
Binaries without the optional module use PDF.js, including older OTA recipients.

`usePdfDetails` renders up to 24 stable tiles per eligible page, with at most two
pages sharing a 6 Mi-pixel visible budget. Tiles have distinct MapLibre IDs and a
`parentId` identifying their overview. Completed tiles appear incrementally;
matching cached tiles remain reusable during pans. Current visible files are
pinned, with cache limits of 64 files and 18 Mi pixels during handoff, reduced to
12 Mi pixels after two seconds. Accounting uses actual output dimensions.

## Verification and builds

Run the dependency-free host-JVM tests with a JDK on PATH:

```sh
sh modules/inukshuk-pdf/scripts/test-geometry.sh
```

They cover the exact Eco crop, fractional dimensions, output bounds, invalid inputs,
rotated/mismatched page sizes, and encoded private paths versus directory/symlink escapes.
Android rendering itself is verified on device; these tests do not emulate PDFium.

Build from an existing generated Android project (no prebuild needed after adding
this local module):

```sh
cd android
./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
```

For iOS, run `sh modules/inukshuk-pdf/ios/Tests/run.sh`, install CocoaPods after
adding the module, and rebuild the iOS development client.

Rebuild the development binary whenever native code changes. Install with
`adb install -r android/app/build/outputs/apk/debug/app-debug.apk` to preserve data;
never uninstall or clear app storage as part of this workflow. New native code
also requires a compatible native runtime for OTA delivery.
