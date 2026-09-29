#!/usr/bin/env python3
"""Derive every app icon / splash PNG from the brand source and masters.

Reproducible, PIL + numpy only. Not run in CI — run it by hand after changing the
logo, look at the outputs (and the --preview sheet), then commit them:

    scripts/brand/render-masters.sh                          # SVG -> PNG masters (Chrome)
    python3 scripts/brand/build-icons.py                     # writes assets/*.png + store/play/icon-512.png
    python3 scripts/brand/build-icons.py --preview out.png   # also writes a mask preview sheet

Inputs:
  assets/branding/inukshuk-logo-square.png  the approved logo, full-bleed 1024²
                          (landscape + mark, square corners — the OS masks them).
                          icon.png IS this file, flattened to RGB.
  assets/brand/background-1024.png  the landscape alone, 1024² — a raster of
                          assets/branding/inukshuk-background.svg
  assets/brand/mark@2x.png  the charcoal inukshuk alone with alpha, 1012x1165 — a
                          2x raster of assets/branding/inukshuk-mark.svg, whose
                          viewBox (374, 392.5, 506 x 582.5) is its box inside the
                          logo's 1254² frame (MARK_BOX below).
  The two rasters are the ONLY non-PIL step: scripts/brand/render-masters.sh
  renders them with headless Chrome (transparent page, exact pixel size).

Outputs:
  assets/icon.png                     1024 RGB (no alpha — App Store rejects it)
  assets/android-icon-background.png  1024 RGB landscape, sized so the launcher's
                                      72/108 viewport shows what the iOS icon shows;
                                      the parallax margin is mirrored landscape
  assets/android-icon-foreground.png  1024 RGBA mark, same scale, inside the safe zone
  assets/android-icon-monochrome.png  1024 RGBA single-colour silhouette (themed icons)
  assets/splash-icon.png              1024 RGBA mark alone (light splash)
  assets/splash-icon-dark.png         1024 RGBA mark in the night tone (dark splash)
  assets/favicon.png                  48 RGB
  store/play/icon-512.png             512 RGB (Play listing)
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / 'assets' / 'brand'
BRANDING = ROOT / 'assets' / 'branding'
ASSETS = ROOT / 'assets'

S = 1024
# The mark's box in the logo's 1254² SVG frame (inukshuk-mark.svg viewBox). In
# the 1024² icon it is ~413 x 476 px, centred at (512.0, 558.3).
FRAME = 1254
MARK_BOX = (374.0, 392.5, 506.0, 582.5)  # x, y, w, h
ICON_FIG_H = MARK_BOX[3] * S / FRAME
ICON_FIG_CX = (MARK_BOX[0] + MARK_BOX[2] / 2) * S / FRAME
ICON_FIG_CY = (MARK_BOX[1] + MARK_BOX[3] / 2) * S / FRAME

# Android adaptive icons: 108 dp layers, 72 dp visible viewport, 66 dp safe circle.
ADAPTIVE_VIEW = S * 72 / 108  # 682.7 px — what the launcher actually shows
ADAPTIVE_SAFE_R = S * 66 / 108 / 2  # 312.9 px

# Night tone for dark surfaces: each channel c -> 60 + 1.05 c (granite #283337
# -> #667276, ~3.5:1 on the dark theme). Mirrored in
# src/ui/components/inukshukStones.ts (nightTone) so splash and loader agree.
NIGHT_A, NIGHT_B = 60, 1.05
MONO_RGB = (255, 255, 255)
# Splash mark height (px of the 1024 canvas); asserted clear of Android 12's mask.
SPLASH_FIG_H = 690


def load_rgba(p: Path) -> Image.Image:
    return Image.open(p).convert('RGBA')


def resize_rgba(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Resize in premultiplied space so edges don't pick up dark/bright fringes."""
    return im.convert('RGBa').resize(size, Image.Resampling.LANCZOS).convert('RGBA')


def figure_layer(fig: Image.Image, fig_h: float, cx: float, cy: float) -> Image.Image:
    """Transparent SxS layer with the mark fig_h px tall, its box centred at (cx, cy).

    Sub-pixel exact: the mark is resampled straight into the canvas with an
    affine map, supersampled 4x then box-filtered down, so no rounding of the
    placement creeps in.
    """
    ss = 4
    k = fig_h / fig.height * ss
    x0 = cx * ss - fig.width * k / 2
    y0 = cy * ss - fig.height * k / 2
    # Pre-shrink to ~the target size with LANCZOS, then place with bicubic.
    pre = resize_rgba(fig, (max(1, round(fig.width * k)), max(1, round(fig.height * k))))
    kx, ky = pre.width / (fig.width * k), pre.height / (fig.height * k)
    big = pre.convert('RGBa').transform(
        (S * ss, S * ss),
        Image.Transform.AFFINE,
        (kx, 0, -x0 * kx, 0, ky, -y0 * ky),
        resample=Image.Resampling.BICUBIC,
    )
    return big.resize((S, S), Image.Resampling.BOX).convert('RGBA')


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
    return Image.fromarray(a.round().astype(np.uint8))


def max_radius(layer: Image.Image, cx: float, cy: float) -> float:
    al = np.asarray(layer.getchannel('A'))
    ys, xs = np.nonzero(al > 8)
    return float(np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2).max())


def build() -> dict[str, Image.Image]:
    logo = Image.open(BRANDING / 'inukshuk-logo-square.png')
    land = Image.open(BRAND / 'background-1024.png').convert('RGB')
    fig = load_rgba(BRAND / 'mark@2x.png')
    assert logo.size == (S, S) and land.size == (S, S), 'masters must be 1024²'
    out: dict[str, Image.Image] = {}

    # iOS / master icon: the approved square logo itself, flattened to RGB.
    out['assets/icon.png'] = rgb(logo.convert('RGBA'))

    # Android adaptive: scale the whole iOS composition by 72/108 about the
    # centre, so the launcher viewport shows the same picture as the iOS icon.
    k = ADAPTIVE_VIEW / S
    view = int(round(ADAPTIVE_VIEW))
    pad = (S - view) // 2
    small = np.asarray(land.resize((view, view), Image.Resampling.LANCZOS))
    # The 18 dp margin only shows during launcher parallax: mirror the edges.
    bg = np.pad(small, ((pad, S - view - pad), (pad, S - view - pad), (0, 0)), mode='reflect')
    out['assets/android-icon-background.png'] = Image.fromarray(bg)
    fg_cx = S / 2 + (ICON_FIG_CX - S / 2) * k
    fg_cy = S / 2 + (ICON_FIG_CY - S / 2) * k
    fg = figure_layer(fig, ICON_FIG_H * k, fg_cx, fg_cy)
    r = max_radius(fg, S / 2, S / 2)
    assert r < ADAPTIVE_SAFE_R, f'foreground leaves the 66 dp safe zone ({r:.0f} px)'
    out['assets/android-icon-foreground.png'] = fg
    m = np.zeros((S, S, 4), np.uint8)
    m[..., :3] = MONO_RGB
    m[..., 3] = np.asarray(fg.getchannel('A'))
    out['assets/android-icon-monochrome.png'] = Image.fromarray(m)

    # Splash: expo-splash-screen draws this image `contain`ed in an imageWidth
    # square; Android 12+ then shows only a circle of 2/3 the 288 dp canvas
    # (radius 96 dp). With imageWidth 200 that circle is radius 0.96 * 512 px of
    # this canvas — size the mark to sit well inside it.
    splash_h = SPLASH_FIG_H
    splash = figure_layer(fig, splash_h, S / 2, S / 2)
    r = max_radius(splash, S / 2, S / 2)
    assert r < 0.96 * S / 2 * 0.95, f'splash figure too close to the Android 12 mask ({r:.0f} px)'
    out['assets/splash-icon.png'] = splash
    out['assets/splash-icon-dark.png'] = figure_layer(night(fig), splash_h, S / 2, S / 2)

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
        m = Image.fromarray(((np.abs(xx) ** 4 + np.abs(yy) ** 4) <= 1).astype(np.uint8) * 255)
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
