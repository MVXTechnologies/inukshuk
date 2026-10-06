# Brand masters

Source artwork for the Inukshuk icon, splash and loader. Marc approved it (the
compact faceted granite figure standing on his landscape). **Don't edit the
derived PNGs in `assets/` by hand.** Change a master here, then run
`python3 scripts/brand/build-icons.py --preview /tmp/icons.png`, look at the
preview sheet, and commit the regenerated files.

| File                                                    | What it is                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `figure-compact.svg`                                    | The figure as vector art, in a 784 × 870 frame: five stones, each clipped to its outline, with flat facet fills.             |
| `stone-compact-{head,arm,torso,leg-left,leg-right}.svg` | Each stone alone, in its own box. The loader's path data (`src/ui/components/inukshukStones.ts`) is copied from these files. |
| `stones-compact.json`                                   | Each stone's `x, y, w, h` inside the 784 × 870 figure frame.                                                                 |
| `figure-compact@2x.png`                                 | A 1568 × 1740 RGBA raster of `figure-compact.svg`. The icon script composites this.                                          |
| `landscape-1024.png`                                    | The landscape on its own, 1024², corners filled because the OS masks them.                                                   |

## How each output is derived (`scripts/brand/build-icons.py`, PIL + numpy)

- **`assets/icon.png`**: the landscape, a soft contact shadow, then the figure at 500 px tall, centred with its box centre at y = 556. It is flattened to RGB because the App Store rejects icons with alpha. It matches the approved `icon-compact-v3.png` to within resampling noise.
- **`android-icon-background.png`**: the landscape scaled to 72/108 of the canvas. That way the launcher's visible viewport shows the same picture as the iOS icon. The 18 dp parallax margin is filled with mirrored landscape.
- **`android-icon-foreground.png`**: the figure plus contact shadow, scaled by the same 72/108, on transparency. The script asserts that it stays inside the 66 dp safe circle.
- **`android-icon-monochrome.png`**: the same silhouette in one opaque colour, for Android 13+ themed icons. The launcher tints it.
- **`splash-icon.png` / `splash-icon-dark.png`**: the figure alone on transparency, sized so it clears Android 12's circular splash mask when `imageWidth` is 200. The dark variant lifts the stones to the _night tone_: each channel becomes 60 + 1.05·c, which turns #273037 into #656E76. It sits on `#13171B`. `InukshukLoader` uses the same transform on dark surfaces.
- **`favicon.png`** (48²) and **`store/play/icon-512.png`** (512², RGB) are downscaled from `icon.png`.
- The website's copies, which GitHub Pages can only serve from `docs/`, are downscaled too: **`docs/icon.png`** (512²), **`docs/apple-touch-icon.png`** (180²) and **`docs/favicon-32.png`** (32², rounded corners). The site logos `docs/assets/brand/logo-{128,256,384}.webp` are still hand exports.

PNG encoders differ between Pillow versions, so a re-run can rewrite a file's bytes with identical pixels. Commit only files whose pixels actually changed: the icon and splash files are part of the runtime fingerprint (`fingerprint.config.js`), so new bytes alone would cut existing installs off from OTA updates.

`figure-compact@2x.png` is the only step that PIL can't do. To regenerate it after editing the SVG, render it headless: with Playwright + Chromium, set the viewport and the SVG `width`/`height` to 1568 × 1740 and take a screenshot with `omitBackground: true`.
