"""Generate ~20 realistic Québec City activities for store screenshots.

Geometry: routed along real paths (routing.openstreetmap.de foot/bike).
Elevation: sampled from the same terrarium DEM the app uses.
Output: tracks/<id>.gpx + tracks.json (library entries with stats).

Usage (needs network and Pillow):
    python3 scripts/store/gen-demo-runs.py <out-dir>
    scripts/store/seed-sim.sh <sim-udid> <out-dir> [light|dark]
"""
import io, json, math, os, random, string, sys, urllib.request
from datetime import datetime, timedelta, timezone
from PIL import Image

OUT = sys.argv[1]
os.makedirs(f'{OUT}/tracks', exist_ok=True)
random.seed(7)

# (name, category, profile, speed m/s, waypoints [lat, lon], loop back to start)
ROUTES = [
    ('Plains of Abraham loop', 'run', 'foot', 3.0,
     [(46.8046, -71.2168), (46.8003, -71.2139), (46.7978, -71.2200), (46.8008, -71.2262), (46.8046, -71.2168)]),
    ('Dufferin Terrace & the Plains', 'run', 'foot', 2.9,
     [(46.8117, -71.2041), (46.8074, -71.2052), (46.8012, -71.2138), (46.7986, -71.2215), (46.8057, -71.2200), (46.8104, -71.2093)]),
    ('Promenade Samuel-De-Champlain', 'bike', 'bike', 5.6,
     [(46.7893, -71.2355), (46.7790, -71.2560), (46.7700, -71.2750), (46.7790, -71.2560), (46.7893, -71.2355)]),
    ('Rivière Saint-Charles loop', 'run', 'foot', 3.1,
     [(46.8166, -71.2236), (46.8199, -71.2345), (46.8180, -71.2470), (46.8130, -71.2560), (46.8175, -71.2440), (46.8166, -71.2236)]),
    ('Corridor des Cheminots', 'bike', 'bike', 6.0,
     [(46.8225, -71.2310), (46.8400, -71.2420), (46.8600, -71.2530), (46.8400, -71.2420), (46.8225, -71.2310)]),
    ('Old Québec walk', 'walk', 'foot', 1.3,
     [(46.8133, -71.2080), (46.8127, -71.2143), (46.8098, -71.2105), (46.8117, -71.2041), (46.8130, -71.2030), (46.8133, -71.2080)]),
    ('Petit-Champlain & the stairs', 'hike', 'foot', 1.4,
     [(46.8117, -71.2041), (46.8126, -71.2025), (46.8110, -71.2020), (46.8140, -71.2050), (46.8117, -71.2041)]),
    ('Bois-de-Coulonge & Cataraqui', 'hike', 'foot', 1.4,
     [(46.7907, -71.2320), (46.7878, -71.2380), (46.7835, -71.2450), (46.7878, -71.2380), (46.7907, -71.2320)]),
    ('Baie de Beauport ride', 'bike', 'bike', 5.2,
     [(46.8190, -71.2075), (46.8260, -71.2030), (46.8385, -71.1975), (46.8260, -71.2030), (46.8190, -71.2075)]),
    ('Domaine de Maizerets', 'run', 'foot', 3.0,
     [(46.8290, -71.2200), (46.8335, -71.2135), (46.8360, -71.2080), (46.8335, -71.2135), (46.8290, -71.2200)]),
    ('Limoilou long run', 'run', 'foot', 3.2,
     [(46.8175, -71.2236), (46.8290, -71.2200), (46.8440, -71.2185), (46.8360, -71.2080), (46.8175, -71.2236)]),
    ('Grande Allée tempo', 'run', 'foot', 3.5,
     [(46.8104, -71.2093), (46.8057, -71.2200), (46.8010, -71.2320), (46.8057, -71.2200), (46.8104, -71.2093)]),
]

# Which templates to repeat (heat builds up on popular corridors).
PLAN = [0, 2, 5, 3, 1, 7, 4, 11, 6, 9, 8, 0, 10, 2, 1, 3, 11, 0, 2, 0]
NAMES = ['Sunrise loop on the Plains', 'Riverside ride to the bridge', 'Old Québec after dinner',
         'Saint-Charles easy 8', 'Dufferin hill repeats', 'Bois-de-Coulonge with the kids',
         'Cheminots commute', 'Grande Allée tempo', 'Petit-Champlain & the stairs',
         'Maizerets recovery run', 'Baie de Beauport ride', 'Plains of Abraham loop',
         'Limoilou long run', 'Promenade Samuel-De-Champlain', 'Terrasse Dufferin run',
         'Rivière Saint-Charles loop', 'Tempo on Grande Allée', 'Plains before work',
         'Sunday ride on the Promenade', 'Plains shakeout']


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'inukshuk-demo-fixtures'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def route(profile, pts):
    coords = ';'.join(f'{lon},{lat}' for lat, lon in pts)
    url = (f'https://routing.openstreetmap.de/routed-{profile}/route/v1/{profile}/{coords}'
           '?overview=full&geometries=geojson')
    j = fetch_json(url)
    return [(lat, lon) for lon, lat in j['routes'][0]['geometry']['coordinates']]


TILES = {}


def elevation(lat, lon, z=14):
    n = 2 ** z
    xf = (lon + 180) / 360 * n
    yf = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    x, y = int(xf), int(yf)
    key = (x, y)
    if key not in TILES:
        url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
        with urllib.request.urlopen(url, timeout=60) as r:
            TILES[key] = Image.open(io.BytesIO(r.read())).convert('RGB')
    px = min(255, int((xf - x) * 256)); py = min(255, int((yf - y) * 256))
    r, g, b = TILES[key].getpixel((px, py))
    return max(0.0, r * 256 + g + b / 256 - 32768)


def hav(a, b):
    R = 6371008.8
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def resample(line, step):
    out = [line[0]]
    carry = 0.0
    for a, b in zip(line, line[1:]):
        d = hav(a, b)
        if d == 0:
            continue
        t = step - carry
        while t <= d:
            f = t / d
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
            t += step
        carry = d - (t - step)
    out.append(line[-1])
    return out


def rid():
    return ''.join(random.choice(string.ascii_letters) for _ in range(12))


geoms = {}
tracks = []
now = datetime(2026, 9, 26, 11, 0, tzinfo=timezone.utc)  # 07:00 in Québec
for i, t in enumerate(PLAN):
    _, cat, prof, speed, wps = ROUTES[t]
    name = NAMES[i]
    if t not in geoms:
        geoms[t] = route(prof, wps)
    step = speed * (2 if prof == 'foot' else 3)  # a fix every 2–3 s
    pts = resample(geoms[t], step)
    # GPS noise that stays coherent (drifts, not jumps): 2–5 m.
    off_lat = off_lon = 0.0
    noisy = []
    for lat, lon in pts:
        off_lat = off_lat * 0.8 + random.gauss(0, 1.6)
        off_lon = off_lon * 0.8 + random.gauss(0, 1.6)
        noisy.append((lat + off_lat / 111_320, lon + off_lon / (111_320 * math.cos(math.radians(lat)))))
    start = now - timedelta(days=int(i * 2.6), hours=random.choice([0, 1, 10, 11]), minutes=random.randint(0, 50))
    ts, eles = [], []
    tcur = start
    dist = 0.0
    fac = 1.0
    for k, p in enumerate(noisy):
        if k:
            d = hav(noisy[k - 1], p)
            dist += d
            fac = 1 + (fac - 1) * 0.985 + random.gauss(0, 0.012)  # drifts over minutes
            fac = min(1.15, max(0.85, fac))
            v = speed * fac
            tcur += timedelta(seconds=max(1.0, d / v))
        ts.append(tcur)
        eles.append(elevation(*pts[k]))
    W = 25  # ~60 m window: the DEM is ~9 m/px and cliffs bleed into riverside paths
    raw = eles
    eles = [round(sorted(raw[max(0, k - W):k + W + 1])[len(raw[max(0, k - W):k + W + 1]) // 2]
                  + random.gauss(0, 0.3), 1) for k in range(len(raw))]
    eles = [round(sum(eles[max(0, k - 8):k + 9]) / len(eles[max(0, k - 8):k + 9]), 1) for k in range(len(eles))]
    # Stats like the app: ascent with a 3 m hysteresis.
    asc = desc = 0.0
    ref = eles[0]
    for e in eles[1:]:
        if e - ref >= 3:
            asc += e - ref; ref = e
        elif ref - e >= 3:
            desc += ref - e; ref = e
    dur = (ts[-1] - ts[0]).total_seconds()
    speeds = [hav(noisy[k - 1], noisy[k]) / max(1e-3, (ts[k] - ts[k - 1]).total_seconds()) for k in range(1, len(noisy))]
    lats = [p[0] for p in noisy]; lons = [p[1] for p in noisy]
    tid = rid()
    with open(f'{OUT}/tracks/{tid}.gpx', 'w') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Inukshuk" '
                'xmlns="http://www.topografix.com/GPX/1/1">\n'
                f'<metadata><name>{name}</name></metadata>\n<trk><name>{name}</name><trkseg>\n')
        for p, e, tt in zip(noisy, eles, ts):
            f.write(f'<trkpt lat="{p[0]:.6f}" lon="{p[1]:.6f}"><ele>{e}</ele>'
                    f'<time>{tt.strftime("%Y-%m-%dT%H:%M:%SZ")}</time></trkpt>\n')
        f.write('</trkseg></trk>\n</gpx>\n')
    tracks.append({
        'id': tid, 'name': name,
        'startedAt': int(ts[0].timestamp() * 1000), 'endedAt': int(ts[-1].timestamp() * 1000),
        'stats': {
            'distanceM': round(dist, 1), 'ascentM': round(asc, 1), 'descentM': round(desc, 1),
            'durationS': int(dur), 'movingTimeS': int(dur), 'avgSpeedMps': round(dist / dur, 2),
            'maxSpeedMps': round(sorted(speeds)[int(len(speeds) * 0.98)], 2),
            'minAltitudeM': min(eles), 'maxAltitudeM': max(eles),
            'bbox': {'minLat': min(lats), 'minLng': min(lons), 'maxLat': max(lats), 'maxLng': max(lons)},
            'pointCount': len(noisy),
        },
        'fileUri': f'tracks/{tid}.gpx', 'notes': [], 'category': cat,
    })
    print(f'{name:36s} {cat:5s} {dist/1000:5.1f} km  +{asc:.0f} m  {dur/60:4.0f} min  {len(noisy)} pts')

json.dump(tracks, open(f'{OUT}/tracks.json', 'w'))
