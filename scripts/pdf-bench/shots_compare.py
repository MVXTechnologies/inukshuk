#!/usr/bin/env python3
"""Screen-level before/after quality: the same camera step photographed on
both builds (runs/<before>/shots vs runs/<after>/shots).

Per step, on the map area (status bar, chrome and tab bar cropped away):
  ssim    SSIM of luma between the two screenshots (1 = identical)
  sharp   gradient energy after / before (> 1 = after is sharper)
and a side-by-side JPEG of a 600 px centre crop for visual inspection.

  venv/bin/python shots_compare.py RUN_BEFORE RUN_AFTER OUT_DIR
"""
import glob
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from quality import grad_energy, luma, ssim  # noqa: E402

before, after, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
print(f"{'step':58} {'ssim':>6} {'sharp':>6}")
for a_path in sorted(glob.glob(os.path.join(after, 'shots', '*.png'))):
    name = os.path.basename(a_path)
    b_path = os.path.join(before, 'shots', name)
    if not os.path.exists(b_path):
        continue
    a = Image.open(a_path).convert('RGB')
    b = Image.open(b_path).convert('RGB')
    if a.size != b.size:
        continue
    w, h = a.size
    box = (0, int(h * 0.12), int(w * 0.8), int(h * 0.85))  # map area, no chrome
    la, lb = luma(a.crop(box)), luma(b.crop(box))
    print(f"{name[:-4]:58} {ssim(la, lb):6.3f} {grad_energy(la) / max(1e-9, grad_energy(lb)):6.3f}")
    cx, cy, s = w // 2, h // 2, 300
    crop = (cx - s, cy - s, cx + s, cy + s)
    pair = Image.new('RGB', (4 * s + 10, 2 * s), 'white')
    pair.paste(b.crop(crop), (0, 0))
    pair.paste(a.crop(crop), (2 * s + 10, 0))
    pair.save(os.path.join(out, name[:-4] + '.jpg'), quality=90)
