"""Photo-like landscape renders from a real DEM (#587/#589 demo fixtures).

Renders what a hiker would see from a point on the trail: the real terrain
(Mapzen/AWS terrarium tiles, z12 ≈ 26 m), autumn forest albedo from noise,
rock on steep slopes, water at sea level, Lambert sun, aerial perspective,
a sky with sun glow and clouds, fine detail noise and film grain. Column
ray-marching with an occlusion "first hit" per pixel row. Needs numpy.
Every pixel is computed here: nothing copyrighted.
"""
import io
import json
import math
import os
import urllib.request

import numpy as np
from PIL import Image, ImageFilter

Z = 12
TILE = 256


def _tile(x, y, cache):
    path = f'{cache}/{Z}_{x}_{y}.png'
    if not os.path.exists(path):
        url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png'
        req = urllib.request.Request(url, headers={'User-Agent': 'inukshuk-demo-fixtures'})
        open(path, 'wb').write(urllib.request.urlopen(req, timeout=30).read())
    a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def lonlat_to_px(lon, lat):
    n = 2 ** Z * TILE
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


class Terrain:
    def __init__(self, lon0, lat0, lon1, lat1, cache):
        os.makedirs(cache, exist_ok=True)
        x0, y0 = lonlat_to_px(lon0, lat1)
        x1, y1 = lonlat_to_px(lon1, lat0)
        tx0, ty0, tx1, ty1 = int(x0 // TILE), int(y0 // TILE), int(x1 // TILE), int(y1 // TILE)
        rows = []
        for ty in range(ty0, ty1 + 1):
            rows.append(np.concatenate([_tile(tx, ty, cache) for tx in range(tx0, tx1 + 1)], axis=1))
        self.h = np.maximum(np.concatenate(rows, axis=0), -2.0)
        self.ox, self.oy = tx0 * TILE, ty0 * TILE
        lat_mid = (lat0 + lat1) / 2
        self.mpp = 156543.03392 * math.cos(math.radians(lat_mid)) / 2 ** Z
        gy, gx = np.gradient(self.h, self.mpp)
        self.gx, self.gy = gx, gy

    def px(self, lon, lat):
        x, y = lonlat_to_px(lon, lat)
        return x - self.ox, y - self.oy

    def sample(self, arr, x, y):
        hgt, wid = arr.shape
        x = np.clip(x, 0, wid - 1.001)
        y = np.clip(y, 0, hgt - 1.001)
        x0, y0 = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
        fx, fy = x - x0, y - y0
        a = arr[y0, x0] * (1 - fx) + arr[y0, x0 + 1] * fx
        b = arr[y0 + 1, x0] * (1 - fx) + arr[y0 + 1, x0 + 1] * fx
        return a * (1 - fy) + b * fy


def _hash(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def vnoise(x, y, seed=0):
    ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = x - ix, y - iy
    ux, uy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _hash(ix, iy, seed), _hash(ix + 1, iy, seed)
    c, d = _hash(ix, iy + 1, seed), _hash(ix + 1, iy + 1, seed)
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy


def fbm(x, y, octaves, seed=0):
    out, amp, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        out = out + vnoise(x, y, seed + o) * amp
        tot += amp
        x, y, amp = x * 2.03, y * 2.03, amp * 0.5
    return out / tot


def render(terrain, lon, lat, heading_deg, *, eye=12.0, pitch=-0.03, hfov=62.0, size=(1600, 1200),
           sun=(110.0, 28.0), seed=1, haze=(0.70, 0.78, 0.86), sky_top=(0.30, 0.48, 0.74),
           max_m=32000.0, clouds=0.5):
    w, h = size
    cx, cy = terrain.px(lon, lat)
    ground = float(terrain.sample(terrain.h, np.array([cx]), np.array([cy]))[0])
    cam_z = ground + eye
    focal = (w / 2) / math.tan(math.radians(hfov) / 2)
    horizon = h / 2 + pitch * focal
    cols = np.arange(w)
    ang = math.radians(heading_deg) + np.arctan((cols - w / 2) / focal)
    dx, dy = np.sin(ang), -np.cos(ang)
    corr = np.cos(ang - math.radians(heading_deg))  # straight-line depth for projection
    sa, se = math.radians(sun[0]), math.radians(sun[1])
    sun_v = np.array([math.sin(sa) * math.cos(se), -math.cos(sa) * math.cos(se), math.sin(se)])

    dists = []
    d = 3.0
    while d < max_m:
        dists.append(d)
        d = d * 1.0045 + 0.8
    n = len(dists)
    Y = np.empty((n, w), np.float32)
    C = np.empty((n, w, 3), np.float32)
    for k, dm in enumerate(dists):
        px = cx + dx * dm / terrain.mpp
        py = cy + dy * dm / terrain.mpp
        wx, wy = px * terrain.mpp, py * terrain.mpp  # metres, for noise
        base = terrain.sample(terrain.h, px, py)
        # Fine relief the 26 m DEM lacks, strongest near the camera.
        detail = (fbm(wx / 40, wy / 40, 4, seed) - 0.5) * 9 * min(1.0, 400 / dm + 0.15)
        hh = base + detail
        gx = terrain.sample(terrain.gx, px, py)
        gy = terrain.sample(terrain.gy, px, py)
        nx, ny, nz = -gx, -gy, np.ones_like(gx)
        nl = np.sqrt(nx * nx + ny * ny + nz * nz)
        lam = np.clip((nx * sun_v[0] + ny * sun_v[1] + nz * sun_v[2]) / nl, 0, 1)
        slope = np.degrees(np.arctan(np.sqrt(gx * gx + gy * gy)))
        # Albedo: an October Laurentian forest (maple reds and golds through
        # spruce and fir), rock on the steep, water at sea level.
        patch = fbm(wx / 180, wy / 180, 4, seed + 7)
        tone = fbm(wx / 35, wy / 35, 3, seed + 11)
        conifer = np.array([0.10, 0.17, 0.11])
        maple = np.array([0.55, 0.20, 0.07])
        gold = np.array([0.62, 0.44, 0.12])
        birch = np.array([0.40, 0.42, 0.14])
        t1 = np.clip((patch - 0.45) * 3.0, 0, 1)[:, None]
        t2 = np.clip((tone - 0.5) * 3, 0, 1)[:, None]
        decid = maple * (1 - t2) + gold * t2
        alb = conifer * (1 - t1) + (decid * 0.75 + birch * 0.25) * t1
        alb = alb * (0.75 + 0.5 * tone[:, None])
        # Crowns and the gaps between them: strong near, averaged out far away.
        crown = fbm(wx / 5, wy / 5, 3, seed + 5)
        near = min(1.0, 1500 / dm)
        alb = alb * (1 + (crown[:, None] - 0.5) * 1.3 * near)
        spr = np.clip((fbm(wx / 3.5, wy / 3.5, 2, seed + 9) - 0.58) * 6, 0, 1)[:, None] * t1
        alb = alb * (1 - spr) + conifer * (0.8 + 0.4 * crown[:, None]) * spr
        rock = np.clip((slope - 32) / 12, 0, 1)[:, None]
        alb = alb * (1 - rock) + np.array([0.36, 0.34, 0.31]) * rock
        water = (base < 4.0)[:, None]
        light = 0.28 + 0.95 * lam[:, None]
        col = alb * light
        col = np.where(water, np.array([0.22, 0.33, 0.42]) * (0.85 + 0.3 * tone[:, None]), col)
        fog = 1 - np.exp(-dm / (11000 if dm > 300 else 9e9))
        col = col * (1 - fog) + np.array(haze) * fog
        hh = np.where(base < 4.0, np.maximum(hh, 0.5), hh)
        Y[k] = horizon + (cam_z - hh) / (dm * corr) * focal
        C[k] = col
    # First hit per pixel row: running minimum of the projected heights.
    M = np.minimum.accumulate(Y, axis=0)
    img = np.empty((h, w, 3), np.float32)
    rows = np.arange(h, dtype=np.float32)
    # Sky
    t = np.clip(rows / max(1.0, horizon), 0, 1)[:, None]
    skycol = np.array(sky_top) * (1 - t ** 0.8) + np.array(haze) * (t ** 0.8)
    img[:] = skycol[:, None, :]
    sx = w / 2 + (math.radians(sun[0]) - math.radians(heading_deg)) * focal
    sy = horizon - math.tan(se) * focal
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    glow = np.exp(-(((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * (w * 0.18) ** 2)))
    img += glow[..., None] * np.array([0.35, 0.28, 0.16])
    if clouds > 0:
        cn = fbm(xx / (w * 0.12), (yy / (h * 0.05)) + 3, 5, seed + 3)
        cm = np.clip((cn - (1 - clouds * 0.62)) * 3.2, 0, 1) * (yy < horizon)
        img = img * (1 - cm[..., None] * 0.85) + np.array([0.96, 0.95, 0.93]) * cm[..., None] * 0.85
    for c in range(w):
        m = M[:, c]
        valid = rows >= m[-1]
        k = np.searchsorted(-m, -rows[valid], side='left')
        k = np.clip(k, 0, n - 1)
        img[valid, c] = C[k, c]
    img = np.clip(img, 0, 1) ** (1 / 1.12)
    out = Image.fromarray((img * 255).astype(np.uint8))
    out = out.resize((2048, 1536), Image.LANCZOS).filter(ImageFilter.UnsharpMask(1.6, 70, 2))
    noise = Image.effect_noise(out.size, 26).convert('RGB')
    return Image.blend(out, noise, 0.05)


def bearing(lon0, lat0, lon1, lat1):
    y = math.sin(math.radians(lon1 - lon0)) * math.cos(math.radians(lat1))
    x = math.cos(math.radians(lat0)) * math.sin(math.radians(lat1)) - math.sin(math.radians(lat0)) * math.cos(
        math.radians(lat1)) * math.cos(math.radians(lon1 - lon0))
    return (math.degrees(math.atan2(y, x)) + 360) % 360
