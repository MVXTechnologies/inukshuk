# iOS PDF detail crops

`InukshukPdf.renderCrop` uses the same arguments and result as Android. A dedicated serial worker accepts one render across module instances and returns `E_PDF_BUSY` for overlap. There is no hard cancellation: admission remains closed until the autorelease pool drains. Module destruction discards a completed output.

The iOS implementation supports only a verified single baseline, interleaved 8-bit RGB JPEG paint. It independently checks unrotated, zero-origin page geometry, unit scale, private Documents/Caches paths, an empty annotation list, image placement, safe graphics state, and a bounded content grammar. Text, paths, clipping, forms, masks, blending, progressive or separate-component JPEG scans and other layouts return **`E_PDF_UNSUPPORTED`** for the caller's existing PDF.js fallback. It never invokes CoreGraphics full PDF drawing.

The recognizer accepts only `q`, `Q`, `cm`, validated `gs`, `cs`/`CS`, and exactly one image `Do`. Content streams are limited to 4 KiB compressed Flate or raw data, 64 KiB decoded data, 1024 tokens and stack depth 32. JPEG data is limited to 64 MiB, source edges to 20,000 pixels, and the decoded source crop to 16 Mi pixels. The output is opaque PNG, at most 3072 pixels per edge and 3 Mi pixels total, written directly to a temporary cache file and atomically published.

The image transform determines the source pixel rectangle. In the original Eco PDF, its 14399×12600 JPEG is painted at 0.24 pt/pixel, leaving a 0.24 pt page-width difference. Normalizing to JPEG dimensions alone would misplace the crop. Fractional crop edges are preserved when drawing the expanded integer JPEG crop.

## Verification

Run `sh modules/inukshuk-pdf/ios/Tests/run.sh`. Optionally pass an original Eco PDF path and a new output PNG path to include the full-file regression. The host suite builds tiny complete PDF fixtures and checks annotation/text/clipping/mask rejection, progressive JPEG rejection, output budgets and private path escapes, plus the real Eco content grammar.

A throwaway iOS 26.3 simulator benchmark of the original Eco crop (1896×1659, normalized rectangle 0.5625/0.1875/0.8125/0.4375) measured three lazy ImageIO draws at 318–415 ms and total extraction/draw/PNG times of 635–838 ms. Sampled peak physical footprint was 129–130 MB; after release it returned to 9 MB. Direct CoreGraphics PDF drawing exceeded 1.6 GB sampled peak footprint, and ImageIO full-page thumbnails exceeded 1.1 GB, so neither is used. The crop was visually aligned with Android and retained readable small labels. Simulator measurements are not a physical-device memory guarantee.

The podspec uses ExpoModulesCore, iOS 16.4 and Swift 5.9, with no added dependency. Run CocoaPods installation and the normal iOS dev-client build after adding the Apple autolink configuration.
