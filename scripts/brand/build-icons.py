#!/usr/bin/env python3
"""Derive every app icon / splash PNG from the brand masters in assets/brand/.

Reproducible, PIL + numpy only. Not run in CI — run it by hand after changing a
master, look at the outputs (and the --preview sheet), then commit them:

    python3 scripts/brand/build-icons.py            # writes assets/*.png + store/play/icon-512.png
    python3 scripts/brand/build-icons.py --preview out.png   # also writes a mask preview sheet

Inputs (assets/brand/):
  landscape-1024.png      the landscape alone, corners filled (the OS masks them)
  figure-compact@2x.png   the compact faceted figure with alpha, 1568x1740 — a
                          2x raster of figure-compact.svg (784x870). It is the
                          ONLY non-PIL step: regenerate it after editing the SVG
                          with a headless browser, e.g. Playwright + Chromium:
                            page.setViewportSize({width: 1568, height: 1740})
                            page.setContent(<svg ... width=1568 height=1740>)
                            page.screenshot({path, omitBackground: true})

Outputs:
  assets/icon.png                     1024 RGB (no alpha — App Store rejects it)
  assets/android-icon-background.png  1024 RGB landscape, sized so the launcher's
                                      72/108 viewport shows what the iOS icon shows
  assets/android-icon-foreground.png  1024 RGBA figure + contact shadow in the safe zone
  assets/android-icon-monochrome.png  1024 RGBA single-colour silhouette (themed icons)
  assets/splash-icon.png              1024 RGBA figure alone (light splash)
  assets/splash-icon-dark.png         1024 RGBA figure in the night tone (dark splash)
  assets/favicon.png                  48 RGB
  store/play/icon-512.png             512 RGB (Play listing)
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / 'assets' / 'brand'
ASSETS = ROOT / 'assets'

S = 1024
# Figure placement in the approved iOS icon (icon-compact-v3): 500 px tall,
# centred horizontally, its box centred 44 px below the canvas centre.
ICON_FIG_H = 500
ICON_FIG_CY = 556
# Contact shadow under the legs (same numbers the approved icon was built with).
SHADOW_RGB = (40, 45, 50)
SHADOW_MAX = 0.28
SHADOW_BLUR = 8

# Android adaptive icons: 108 dp layers, 72 dp visible viewport, 66 dp safe circle.
ADAPTIVE_VIEW = S * 72 / 108  # 682.7 px — what the launcher actually shows
ADAPTIVE_SAFE_R = S * 66 / 108 / 2  # 312.9 px

# Night tone for dark surfaces: each channel c -> 60 + 1.05 c (base granite
# #273037 -> #656E76, ~3.5:1 on the dark theme). Mirrored in
# src/ui/components/inukshukStones.ts (nightTone) so splash and loader agree.
NIGHT_A, NIGHT_B = 60, 1.05
MONO_RGB = (255, 255, 255)


def load_rgba(p: Path) -> Image.Image:
    return Image.open(p).convert('RGBA')


def resize_rgba(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Resize in premultiplied space so edges don't pick up dark/bright fringes."""
    return im.convert('RGBa').resize(size, Image.Resampling.LANCZOS).convert('RGBA')


def scaled_figure(fig: Image.Image, height: float) -> Image.Image:
    k = height / fig.height
    return resize_rgba(fig, (int(fig.width * k), int(fig.height * k)))


def place(fig: Image.Image, cx: float, cy: float) -> tuple[int, int]:
    return int(round(cx)) - fig.width // 2, int(round(cy)) - fig.height // 2


def contact_shadow(fig_w: int, bottom_y: int, cx: int) -> np.ndarray:
    """Soft ellipse under the legs, as an alpha map in [0, SHADOW_MAX]."""
    m = Image.new('L', (S, S), 0)
    rx, ry = int(fig_w * 0.36), 10
    ImageDraw.Draw(m).ellipse((cx - rx, bottom_y - ry, cx + rx, bottom_y + ry), fill=255)
    m = m.filter(ImageFilter.GaussianBlur(SHADOW_BLUR))
    return np.asarray(m, np.float32) / 255 * SHADOW_MAX


def figure_layer(fig: Image.Image, fig_h: float, cx: float, cy: float, shadow: bool) -> Image.Image:
    """Transparent SxS layer: optional contact shadow, figure over it."""
    f = scaled_figure(fig, fig_h)
    x, y = place(f, cx, cy)
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    if shadow:
        a = contact_shadow(f.width, y + f.height - 4, int(round(cx)))
        sh = np.zeros((S, S, 4), np.uint8)
        sh[..., :3] = SHADOW_RGB
        sh[..., 3] = np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)
        layer = Image.fromarray(sh, 'RGBA')
    layer.alpha_composite(f, (x, y))
    return layer


def rgb(im: Image.Image) -> Image.Image:
    """Flatten to RGB (no alpha channel at all)."""
    if im.mode == 'RGB':
        return im
    bg = Image.new('RGB', im.size, (255, 255, 255))
    bg.paste(im, mask=im.getchannel('A'))
    return bg


def night(fig: Image.Image) -> Image.Image:
    a = np.asarray(fig).astype(np.float32)
    a[..., :3] = np.clip(NIGHT_A + NIGHT_B * a[..., :3], 0, 255)
    return Image.fromarray(a.round().astype(np.uint8), 'RGBA')


def max_radius(layer: Image.Image, cx: float, cy: float) -> float:
    al = np.asarray(layer.getchannel('A'))
    ys, xs = np.nonzero(al > 8)
    return float(np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2).max())


def build() -> dict[str, Image.Image]:
    land = Image.open(BRAND / 'landscape-1024.png').convert('RGB')
    fig = load_rgba(BRAND / 'figure-compact@2x.png')
    out: dict[str, Image.Image] = {}

    # iOS / master icon.
    icon = land.convert('RGBA')
    icon.alpha_composite(figure_layer(fig, ICON_FIG_H, S / 2, ICON_FIG_CY, shadow=True))
    out['assets/icon.png'] = rgb(icon)

    # Android adaptive: scale the whole iOS composition by 72/108 about the
    # centre, so the launcher viewport shows the same picture as the iOS icon.
    k = ADAPTIVE_VIEW / S
    view = int(round(ADAPTIVE_VIEW))
    pad = (S - view) // 2
    small = np.asarray(land.resize((view, view), Image.Resampling.LANCZOS))
    # The 18 dp margin only shows during launcher parallax: mirror the edges.
    bg = np.pad(small, ((pad, S - view - pad), (pad, S - view - pad), (0, 0)), mode='reflect')
    out['assets/android-icon-background.png'] = Image.fromarray(bg, 'RGB')
    fg_cy = S / 2 + (ICON_FIG_CY - S / 2) * k
    fg = figure_layer(fig, ICON_FIG_H * k, S / 2, fg_cy, shadow=True)
    r = max_radius(figure_layer(fig, ICON_FIG_H * k, S / 2, fg_cy, shadow=False), S / 2, S / 2)
    assert r < ADAPTIVE_SAFE_R, f'foreground leaves the 66 dp safe zone ({r:.0f} px)'
    out['assets/android-icon-foreground.png'] = fg
    mono = figure_layer(fig, ICON_FIG_H * k, S / 2, fg_cy, shadow=False)
    m = np.zeros((S, S, 4), np.uint8)
    m[..., :3] = MONO_RGB
    m[..., 3] = np.asarray(mono.getchannel('A'))
    out['assets/android-icon-monochrome.png'] = Image.fromarray(m, 'RGBA')

    # Splash: expo-splash-screen draws this image `contain`ed in an imageWidth
    # square; Android 12+ then shows only a circle of 2/3 the 288 dp canvas
    # (radius 96 dp). With imageWidth 200 that circle is radius 0.96 * 512 px of
    # this canvas — size the figure to sit well inside it.
    splash_h = 690
    splash = figure_layer(fig, splash_h, S / 2, S / 2, shadow=False)
    r = max_radius(splash, S / 2, S / 2)
    assert r < 0.96 * S / 2 * 0.95, f'splash figure too close to the Android 12 mask ({r:.0f} px)'
    out['assets/splash-icon.png'] = splash
    out['assets/splash-icon-dark.png'] = figure_layer(night(fig), splash_h, S / 2, S / 2, shadow=False)

    out['assets/favicon.png'] = out['assets/icon.png'].resize((48, 48), Image.Resampling.LANCZOS)
    out['store/play/icon-512.png'] = out['assets/icon.png'].resize((512, 512), Image.Resampling.LANCZOS)
    return out


def masked(im: Image.Image, shape: str, size: int) -> Image.Image:
    im = im.convert('RGBA').resize((size, size), Image.Resampling.LANCZOS)
    m = Image.new('L', (size * 4, size * 4), 0)
    d = ImageDraw.Draw(m)
    n = size * 4
    if shape == 'circle':
        d.ellipse((0, 0, n - 1, n - 1), fill=255)
    elif shape == 'rounded':
        d.rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * 0.12), fill=255)
    else:  # squircle (superellipse n=4, close to iOS / Pixel squircle)
        t = np.linspace(-1, 1, n)
        xx, yy = np.meshgrid(t, t)
        m = Image.fromarray(((np.abs(xx) ** 4 + np.abs(yy) ** 4) <= 1).astype(np.uint8) * 255, 'L')
    im.putalpha(m.resize((size, size), Image.Resampling.LANCZOS))
    return im


def preview(out: dict[str, Image.Image], path: Path) -> None:
    """iOS icon vs the Android adaptive composite under three launcher masks."""
    comp = out['assets/android-icon-background.png'].convert('RGBA')
    comp.alpha_composite(out['assets/android-icon-foreground.png'])
    view = int(round(ADAPTIVE_VIEW))
    pad = (S - view) // 2
    android = comp.crop((pad, pad, pad + view, pad + view))
    tiles = [masked(out['assets/icon.png'], 'squircle', 220)]
    tiles += [masked(android, s, 220) for s in ('circle', 'squircle', 'rounded')]
    mono = Image.new('RGBA', (S, S), (38, 50, 56, 255))
    mono.alpha_composite(out['assets/android-icon-monochrome.png'])
    tiles.append(masked(mono.crop((pad, pad, pad + view, pad + view)), 'circle', 220))
    for key, bgc in (('assets/splash-icon.png', (0xF2, 0xEC, 0xE0)), ('assets/splash-icon-dark.png', (0x13, 0x17, 0x1B))):
        t = Image.new('RGBA', (220, 220), bgc + (255,))
        t.alpha_composite(resize_rgba(out[key], (150, 150)), (35, 35))
        tiles.append(t)
    sheet = Image.new('RGBA', (len(tiles) * 240 + 20, 260), (0xFB, 0xF8, 0xF2, 255))
    for i, t in enumerate(tiles):
        sheet.alpha_composite(t, (20 + i * 240, 20))
    sheet.convert('RGB').save(path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--preview', type=Path, help='also write a launcher-mask preview sheet here')
    ap.add_argument('--out', type=Path, default=ROOT, help='output root (default: the repo)')
    args = ap.parse_args()
    out = build()
    for rel, im in out.items():
        p = args.out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        im.save(p, optimize=True)
        print(f'{rel:40s} {im.size[0]}x{im.size[1]} {im.mode}')
    if args.preview:
        preview(out, args.preview)
        print('preview', args.preview)


if __name__ == '__main__':
    main()
