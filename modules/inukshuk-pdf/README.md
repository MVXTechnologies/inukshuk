# Inukshuk Android PDF detail renderer

Local Expo SDK 56 module, autolinked as `InukshukPdf`. Uses Android's API 21
`PdfRenderer`; no additional library dependency. Existing Android minSdk is 24.

`renderCrop({fileUri, pageIndex, pageWidthPt, pageHeightPt, crop: {x0, y0, x1, y1}, targetWidthPx})`
returns a promise of `{fileUri, widthPx, heightPx, pageWidthPt, pageHeightPt, pageCount, loadMs, renderMs}`.
The result URI is a PNG in app cache `overlays/pdf-detail-native-UUID.png`.
`renderMs` includes bitmap allocation, native rendering and PNG encoding/writing.

The caller must first verify with PDF.js that the page has rotation 0, UserUnit 1,
and a zero-origin visible page box matching the georeference dimensions.
PdfRenderer does not expose those metadata fields. The native side validates finite
crop coordinates, positive dimensions, integer page index, actual page dimensions
(with less than one point of integer-rounding tolerance), and private file paths.
Fractional verified page dimensions remain authoritative for crop geometry.

Only canonical `file:` paths inside the application's `filesDir` or `cacheDir` are
accepted. URI hosts, query strings, fragments, non-file schemes, directories,
symlink escapes and unreadable files are rejected. Output is initialized white,
limited to 2048 pixels per edge and 3 Mi pixels, encoded directly to a temporary
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
`E_PDF_CONTEXT`. There is no native API on iOS or older app binaries.

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

Rebuild the development binary whenever native code changes. Install with
`adb install -r android/app/build/outputs/apk/debug/app-debug.apk` to preserve data;
never uninstall or clear app storage as part of this workflow. New native code
also requires a compatible native runtime for OTA delivery.
