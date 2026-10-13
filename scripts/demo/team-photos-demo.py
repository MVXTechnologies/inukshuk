#!/usr/bin/env python3
"""Demo fixture for team mode + trail photos (#589 / #587): one realistic
Québec hike (Mont-Sainte-Anne, routed on OSM foot paths) with 7 geotagged
landscape photos placed along it, in the app's own on-disk format:

  <out>/tracks/<id>.gpx              the recording (1 Hz-ish, elevation, times)
  <out>/track.json                   its Library summary (TrackSummary)
  <out>/photos/<id>/photos.json      the photo sidecar (v1)
  <out>/photos/<id>/<pid>.jpg        display copy, long edge 2048 px
  <out>/photos/<id>/<pid>.sq.jpg     240 px square thumbnail
  <out>/photos/<id>/<pid>.map2.png   264 px round map sprite (2x)

The photos are RENDERED from the real terrain round the trail (terrarium DEM
tiles, autumn-forest albedo, sun, haze, sky; `terrain_photos.py`) from each
photo's own position — nothing copyrighted. Seed a simulator with
scripts/demo/seed-team-demo.sh. Needs numpy + Pillow; routing uses
routing.openstreetmap.de and the DEM AWS terrarium tiles (both cached in <out>).

  usage: team-photos-demo.py <out-dir>
"""
import json
import math
import os
import random
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1]
TRACK_ID = 'msaSommet2026'
NAME = 'Mont-Sainte-Anne · sentier du sommet'
START = datetime(2026, 10, 4, 13, 5, tzinfo=timezone.utc)  # 09:05 EDT
BASE, SUMMIT = (47.0745, -70.9065), (47.0874, -70.9320)
VIA = [(47.0800, -70.9180)]


def route():
    cache = f'{OUT}/route.json'
    if os.path.exists(cache):
        return json.load(open(cache))
    pts = [BASE, SUMMIT, *VIA, BASE]
    q = ';'.join(f'{lon},{lat}' for lat, lon in pts)
    url = f'https://routing.openstreetmap.de/routed-foot/route/v1/foot/{q}?overview=full&geometries=geojson'
    req = urllib.request.Request(url, headers={'User-Agent': 'inukshuk-demo-fixtures'})
    coords = json.load(urllib.request.urlopen(req, timeout=30))['routes'][0]['geometry']['coordinates']
    json.dump(coords, open(cache, 'w'))
    return coords


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[1], a[0], b[1], b[0]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def densify(coords, step=8.0):
    out = [coords[0]]
    for a, b in zip(coords, coords[1:]):
        d = hav(a, b)
        n = max(1, int(d // step))
        for i in range(1, n + 1):
            t = i / n
            out.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    return out


# ── Photos: rendered from the real DEM (scripts/demo/terrain_photos.py) ──

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from terrain_photos import Terrain, render  # noqa: E402

def sprite(src):
    s = 264
    side = min(src.size)
    src = src.crop(((src.width - side) // 2, (src.height - side) // 2, (src.width + side) // 2, (src.height + side) // 2))
    img = src.resize((s, s), Image.LANCZOS).convert('RGBA')
    mask = Image.new('L', (s * 4, s * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, s * 4 - 1, s * 4 - 1], fill=255)
    mask = mask.resize((s, s), Image.LANCZOS)
    out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    ring = Image.new('L', (s * 4, s * 4), 0)
    ImageDraw.Draw(ring).ellipse([0, 0, s * 4 - 1, s * 4 - 1], outline=255, width=56)
    out.paste((247, 244, 238, 255), (0, 0), ring.resize((s, s), Image.LANCZOS))
    return out


def main():
    coords = densify(route())
    cum = [0.0]
    for a, b in zip(coords, coords[1:]):
        cum.append(cum[-1] + hav(a, b))
    total = cum[-1]
    s_lat, s_lon = SUMMIT
    d_summit = [hav(c, [s_lon, s_lat]) for c in coords]
    i_summit = d_summit.index(min(d_summit))
    eles = []
    for i in range(len(coords)):
        # 175 m at the base to 800 m at the summit, an S-curve each way.
        f = cum[i] / cum[i_summit] if i <= i_summit else (total - cum[i]) / (total - cum[i_summit])
        eles.append(round(175 + 625 * (0.5 - 0.5 * math.cos(math.pi * max(0, min(1, f)))) + random.Random(i).uniform(-1.5, 1.5), 1))
    # Walking times: slower uphill, a 20 min summit stop.
    times, t = [], START
    for i in range(len(coords)):
        if i:
            dz = eles[i] - eles[i - 1]
            v = 0.85 if dz > 0.3 else 1.25
            t += timedelta(seconds=(cum[i] - cum[i - 1]) / v)
            if i == i_summit:
                t += timedelta(minutes=20)
        times.append(t)
    os.makedirs(f'{OUT}/tracks', exist_ok=True)
    with open(f'{OUT}/tracks/{TRACK_ID}.gpx', 'w') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Inukshuk" '
                f'xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>{NAME}</name></metadata>\n'
                f'<trk><name>{NAME}</name><trkseg>\n')
        for (lon, lat), e, tt in zip(coords, eles, times):
            f.write(f'<trkpt lat="{lat:.6f}" lon="{lon:.6f}"><ele>{e}</ele><time>{tt.strftime("%Y-%m-%dT%H:%M:%SZ")}</time></trkpt>\n')
        f.write('</trkseg></trk>\n</gpx>\n')
    asc = sum(max(0, b - a) for a, b in zip(eles, eles[1:]))
    dur = (times[-1] - times[0]).total_seconds()
    lats = [c[1] for c in coords]
    lons = [c[0] for c in coords]

    terrain = Terrain(-71.30, 46.82, -70.62, 47.26, f'{OUT}/dem')
    plan = [  # (fraction of the way or None = summit, heading °, sun (az, el), caption)
        (0.05, 330, (115, 22), 'Le départ : la montagne en couleurs'),
        (0.20, 200, (125, 28), 'La vallée du Saint-Laurent'),
        (0.33, 85, (140, 33), 'Vers Charlevoix'),
        (0.44, 15, (150, 36), 'Les Laurentides au nord'),
        (None, 165, (165, 38), 'Au sommet : le fleuve et l’île d’Orléans'),
        (0.72, 250, (205, 34), 'Vers Québec'),
        (0.97, 235, (238, 9), 'Retour au pied de la montagne'),
    ]
    pdir = f'{OUT}/photos/{TRACK_ID}'
    os.makedirs(pdir, exist_ok=True)
    photos = []
    for n, (frac, heading, sun, caption) in enumerate(plan):
        i = i_summit if frac is None else min(len(coords) - 1, int(frac * len(coords)))
        pid = f'demoPhoto{n + 1:02d}'
        dusk = sun[1] < 12
        img = render(terrain, coords[i][0], coords[i][1], heading, eye=40, pitch=-0.07,
                     sun=sun, seed=3 + n, size=(1600, 1200), clouds=0.35 + 0.1 * (n % 3),
                     haze=(0.86, 0.68, 0.55) if dusk else (0.70, 0.78, 0.86),
                     sky_top=(0.22, 0.28, 0.50) if dusk else (0.30, 0.48, 0.74))
        img.save(f'{pdir}/{pid}.jpg', quality=82, optimize=True)
        side = min(img.size)
        sq = img.crop(((img.width - side) // 2, (img.height - side) // 2, (img.width + side) // 2, (img.height + side) // 2))
        th = sq.resize((240, 240), Image.LANCZOS)
        th.save(f'{pdir}/{pid}.sq.jpg', quality=80, optimize=True)
        sprite(img).save(f'{pdir}/{pid}.map2.png', optimize=True)
        size = sum(os.path.getsize(f'{pdir}/{pid}{ext}') for ext in ('.jpg', '.sq.jpg', '.map2.png'))
        taken = int((times[i] + timedelta(seconds=40)).timestamp() * 1000)
        photos.append({
            'id': pid, 'trackId': TRACK_ID, 'distanceM': round(cum[i], 1), 'lngLat': coords[i],
            'elevationM': eles[i], 'placement': 'time', 'takenAt': taken, 'takenAtSource': 'exif-offset',
            'file': f'photos/{TRACK_ID}/{pid}.jpg', 'thumb': f'photos/{TRACK_ID}/{pid}.sq.jpg',
            'sprite': f'photos/{TRACK_ID}/{pid}.map2.png', 'width': img.width, 'height': img.height,
            'bytes': size, 'caption': caption, 'createdAt': taken, 'updatedAt': taken,
        })
        print(f'{pid} {heading:3d}° {cum[i] / 1000:4.1f} km {eles[i]:5.0f} m  thumb {os.path.getsize(pdir + "/" + pid + ".sq.jpg") // 1024} KB')
    json.dump({'version': 1, 'trackId': TRACK_ID, 'photos': photos, 'comments': []}, open(f'{pdir}/photos.json', 'w'))
    summary = {
        'id': TRACK_ID, 'name': NAME,
        'startedAt': int(times[0].timestamp() * 1000), 'endedAt': int(times[-1].timestamp() * 1000),
        'stats': {
            'distanceM': round(total, 1), 'ascentM': round(asc, 1), 'descentM': round(asc, 1),
            'durationS': int(dur), 'movingTimeS': int(dur - 1200), 'avgSpeedMps': round(total / dur, 2),
            'maxSpeedMps': 1.6, 'minAltitudeM': min(eles), 'maxAltitudeM': max(eles),
            'bbox': {'minLat': min(lats), 'minLng': min(lons), 'maxLat': max(lats), 'maxLng': max(lons)},
            'pointCount': len(coords),
        },
        'fileUri': f'tracks/{TRACK_ID}.gpx', 'notes': [], 'category': 'hike',
        'photoCount': len(photos), 'coverPhotoId': photos[0]['id'],
    }
    json.dump(summary, open(f'{OUT}/track.json', 'w'))
    print(f'{NAME}: {total / 1000:.1f} km, +{asc:.0f} m, {dur / 3600:.1f} h, {len(coords)} pts')


main()
