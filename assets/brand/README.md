# Brand masters

The app icon and splash come from the redrawn Inukshuk logo in
`assets/branding/` (vector source, see its README). Marc approved
`inukshuk-logo-square.png` as the icon. **Don't edit the derived PNGs in
`assets/` by hand.** Change the SVGs in `assets/branding/`, then run:

```sh
scripts/brand/render-masters.sh                               # SVG -> PNG masters (headless Chrome)
python3 scripts/brand/build-icons.py --preview /tmp/icons.png # every icon/splash output
```

Look at the preview sheet, then commit the regenerated files.

| File                                                    | What it is                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `background-1024.png`                                   | `inukshuk-background.svg` (the landscape alone) rendered at 1024², full-bleed. Used for the Android adaptive background.                    |
| `mark@2x.png`                                           | `inukshuk-mark.svg` (the charcoal inukshuk alone) rendered at 2x its 506 × 582.5 box, 1012 × 1165 RGBA. Used for the foreground and splash. |
| `figure-compact.svg`                                    | The previous compact faceted figure. It is no longer in the icon, but it is still the source of the in-app loader.                          |
| `stone-compact-{head,arm,torso,leg-left,leg-right}.svg` | Each stone of that figure alone. The loader's path data (`src/ui/components/inukshukStones.ts`) is copied from these files.                 |
| `stones-compact.json`                                   | Each stone's `x, y, w, h` inside the 784 × 870 figure frame (loader layout).                                                                |

## How each output is derived (`scripts/brand/build-icons.py`, PIL + numpy)

- **`assets/icon.png`**: `assets/branding/inukshuk-logo-square.png` itself, flattened to RGB because the App Store rejects icons with alpha. iOS masks the corners.
- **`android-icon-background.png`**: the landscape scaled to 72/108 of the canvas. That way the launcher's visible viewport shows the same picture as the iOS icon under any mask (circle, squircle). The 18 dp parallax margin is filled with mirrored landscape.
- **`android-icon-foreground.png`**: the mark at the same 72/108 scale and at its exact position in the logo, on transparency. The script asserts that it stays inside the 66 dp safe circle.
- **`android-icon-monochrome.png`**: the same silhouette in one opaque colour, for Android 13+ themed icons. The launcher tints it.
- **`splash-icon.png` / `splash-icon-dark.png`**: the mark alone on transparency, sized so it clears Android 12's circular splash mask when `imageWidth` is 200. The dark variant lifts the stones to the _night tone_: each channel becomes 60 + 1.05·c, which turns #283337 into #667276. It sits on `#13171B`.
- **`favicon.png`** (48²) and **`store/play/icon-512.png`** (512², RGB) are downscaled from `icon.png`.

`render-masters.sh` is the only step that PIL can't do. It renders each SVG in headless Chrome on a transparent page at an exact pixel size.

`assets/icon-source.png` is the older painted logo. It stays because `src/ui/theme.ts` documents its palette as sampled from that file.
