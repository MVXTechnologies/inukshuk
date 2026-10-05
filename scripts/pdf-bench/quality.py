#!/usr/bin/env python3
"""Objective quality check for the rasters the app put on the map.

For every tile PNG a bench run uploaded (runs/<run>/tiles/<map>/*.png + .json),
render the SAME crop of the same page at the SAME pixel size with an
independent renderer (MuPDF, via PyMuPDF), with aerial imagery hidden the way
the app's layer plan hides it, and compare:

  ssim      mean SSIM of luma, 7x7 windows (1 = identical)
  sharp     gradient energy of the app's raster / the reference's
            (< 1 = softer than a true full-resolution render; an upscaled
            half-resolution raster scores ~0.4-0.6)
  ppp       raster pixels per page point (resolution actually delivered)

A calibration row per map renders the reference at half resolution and
upscales it, so the reader sees what a "reduced quality" raster scores.

  venv/bin/python quality.py RUN_DIR CORPUS_DIR [--max N]
"""
import glob
import json
import os
import re
import sys

import fitz  # PyMuPDF
import numpy as np
from PIL import Image

IMAGERY = re.compile(r'^\s*(ortho[\s_-]*(image|imagery|images|photo(s|graphs?|graphy)?)|aerial([\s_-]*(image|imagery|images|photo(s|graphs?|graphy)?))?|satellite([\s_-]*(image|imagery|images))?|imagery)\s*$', re.I)


def luma(img):
    a = np.asarray(img.convert('RGBA'), dtype=np.float64)
    rgb = a[..., :3] * (a[..., 3:4] / 255.0) + 255.0 * (1 - a[..., 3:4] / 255.0)  # over white
    return rgb @ np.array([0.299, 0.587, 0.114])


def box(x, k=7):
    c = np.cumsum(np.cumsum(np.pad(x, ((1, 0), (1, 0))), 0), 1)
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def ssim(a, b):
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ma, mb = box(a), box(b)
    va = box(a * a) - ma * ma
    vb = box(b * b) - mb * mb
    cov = box(a * b) - ma * mb
    s = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
    return float(s.mean())


def grad_energy(a):
    gx = np.diff(a, axis=1)
    gy = np.diff(a, axis=0)
    return float((gx * gx).mean() + (gy * gy).mean())


def open_doc(path):
    doc = fitz.open(path)
    try:
        ui = doc.layer_ui_configs()
        for item in ui:
            if IMAGERY.match(item.get('text', '')) and item.get('on'):
                doc.set_layer_ui_config(item['number'], 2)  # off
    except Exception:
        pass
    return doc


def reference(doc, page_index, crop, w, h):
    page = doc[page_index]
    page.set_rotation(0)
    r = page.rect  # crop box, top-left origin, unrotated
    x0, y0, x1, y1 = crop
    clip = fitz.Rect(r.x0 + x0 * r.width, r.y0 + y0 * r.height, r.x0 + x1 * r.width, r.y0 + y1 * r.height)
    m = fitz.Matrix(w / clip.width, h / clip.height)
    pix = page.get_pixmap(matrix=m, clip=clip, alpha=False)
    img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    if img.size != (w, h):
        img = img.resize((w, h), Image.LANCZOS)
    return img, r


def main():
    run, corpus = sys.argv[1], sys.argv[2]
    limit = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 10 ** 9
    out = []
    for mapdir in sorted(glob.glob(os.path.join(run, 'tiles', '*'))):
        slug = os.path.basename(mapdir)
        pdf = os.path.join(corpus, slug + '.pdf')
        if not os.path.exists(pdf):
            continue
        doc = open_doc(pdf)
        calibrated = False
        for png in sorted(glob.glob(os.path.join(mapdir, '*.png')))[:limit]:
            meta = json.load(open(png[:-4] + '.json'))
            m = re.match(r'^[^:]+:(\d+)(?::tile:(\d+):(\d+):(\d+):(\d+))?$', meta['id'])
            if not m:
                continue
            page_index = int(m.group(1))
            if m.group(2):
                div, x, y = int(m.group(2)), int(m.group(3)), int(m.group(4))
                crop = (x / div, y / div, (x + 1) / div, (y + 1) / div)
            else:
                crop = (0, 0, 1, 1)
            app = Image.open(png)
            w, h = app.size
            ref, rect = reference(doc, page_index, crop, w, h)
            a, b = luma(app), luma(ref)
            row = {
                'map': slug, 'step': meta.get('step'), 'id': meta['id'], 'w': w, 'h': h,
                'ppp': round(w / (rect.width * (crop[2] - crop[0])), 3),
                'ssim': round(ssim(a, b), 4),
                'sharp': round(grad_energy(a) / max(1e-9, grad_energy(b)), 3),
            }
            out.append(row)
            if not calibrated and m.group(2):
                calibrated = True
                half = ref.resize((max(1, w // 2), max(1, h // 2)), Image.LANCZOS).resize((w, h), Image.BICUBIC)
                c = luma(half)
                out.append({'map': slug, 'step': 'CALIBRATION half-res reference', 'id': meta['id'], 'w': w, 'h': h,
                            'ppp': row['ppp'] / 2, 'ssim': round(ssim(c, b), 4),
                            'sharp': round(grad_energy(c) / max(1e-9, grad_energy(b)), 3)})
    json.dump(out, open(os.path.join(run, 'quality.json'), 'w'), indent=1)
    by = {}
    for r in out:
        if r['step'].startswith('CALIBRATION'):
            print('  calib', r['map'], 'ssim', r['ssim'], 'sharp', r['sharp'])
            continue
        by.setdefault(r['map'], []).append(r)
    for slug, rows in by.items():
        s = sorted(r['ssim'] for r in rows)
        sh = sorted(r['sharp'] for r in rows)
        print(f"{slug}: n={len(rows)} ssim min {s[0]} p50 {s[len(s)//2]}  sharp min {sh[0]} p50 {sh[len(sh)//2]}")


if __name__ == '__main__':
    main()
