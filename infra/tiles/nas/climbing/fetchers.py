"""Fetchers for OpenBeta (weekly Parquet export, CC0) and camptocamp
(collaborative waypoints, CC BY-SA). OSM is in osm_fetch.py.

Both are polite and cached: OpenBeta is one ~11 MB download when GitHub has a
new release; camptocamp is one list walk (100 per page) and one document
request per crag whose version changed since last month, at most one request
a second.
"""
import json
import os
import time
import urllib.error
import urllib.request

from common import USER_AGENT, log, read_json, write_json

OB_RELEASE_API = 'https://api.github.com/repos/OpenBeta/parquet-exporter/releases/latest'
OB_ASSET = 'openbeta-climbs.parquet'
C2C_API = 'https://api.camptocamp.org'
C2C_PAUSE_S = float(os.environ.get('C2C_PAUSE_S', '1.0'))


def _get(url, timeout=120, retries=4):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            last = f'HTTP {e.code}'
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = str(e)[:200]
        wait = 15 * 2**attempt
        log(f'  {url}: {last}; retry in {wait}s')
        time.sleep(wait)
    raise RuntimeError(f'{url}: {last}')


def fetch_openbeta(raw_dir):
    """The latest weekly release; returns the local Parquet path."""
    os.makedirs(raw_dir, exist_ok=True)
    release = json.loads(_get(OB_RELEASE_API))
    tag = release['tag_name']
    asset = next((a for a in release.get('assets', []) if a['name'] == OB_ASSET), None)
    if asset is None:
        raise RuntimeError(f'openbeta: release {tag} has no {OB_ASSET}')
    path = os.path.join(raw_dir, f'openbeta-climbs-{tag}.parquet')
    if os.path.exists(path) and os.path.getsize(path) == asset['size']:
        log(f'openbeta: {tag} already here')
        return path
    log(f"openbeta: downloading {tag} ({asset['size'] / 1e6:.1f} MB)")
    data = _get(asset['browser_download_url'], timeout=600)
    if len(data) != asset['size']:
        raise RuntimeError(f'openbeta: got {len(data)} bytes, expected {asset["size"]}')
    with open(path + '.tmp', 'wb') as f:
        f.write(data)
    os.replace(path + '.tmp', path)
    # Keep this release and the one before (the fallback), nothing older.
    olds = sorted(
        n for n in os.listdir(raw_dir) if n.startswith('openbeta-climbs-') and n.endswith('.parquet')
    )
    for name in olds[:-2]:
        os.remove(os.path.join(raw_dir, name))
    return path


def latest_openbeta(raw_dir):
    names = sorted(
        n for n in os.listdir(raw_dir) if n.startswith('openbeta-climbs-') and n.endswith('.parquet')
    ) if os.path.isdir(raw_dir) else []
    return os.path.join(raw_dir, names[-1]) if names else None


def _c2c_stamp(doc):
    """A change marker: the document's version plus its locales' and geometry's."""
    parts = [doc.get('version') or 0, (doc.get('geometry') or {}).get('version') or 0]
    parts += sorted((loc.get('lang'), loc.get('version')) for loc in doc.get('locales') or [])
    return json.dumps(parts)


def fetch_c2c(raw_dir):
    """Every collaborative `climbing_outdoor` waypoint, one JSON per document."""
    docs_dir = os.path.join(raw_dir, 'docs')
    os.makedirs(docs_dir, exist_ok=True)
    stamps_path = os.path.join(raw_dir, 'stamps.json')
    stamps = read_json(stamps_path, {})
    listed = {}
    offset = 0
    total = None
    while total is None or offset < total:
        page = json.loads(
            _get(f'{C2C_API}/waypoints?wtyp=climbing_outdoor&limit=100&offset={offset}')
        )
        total = page.get('total') or 0
        docs = page.get('documents') or []
        if not docs:
            break
        for d in docs:
            listed[str(d['document_id'])] = _c2c_stamp(d)
        offset += len(docs)
        time.sleep(C2C_PAUSE_S)
    log(f'c2c: {len(listed)} climbing waypoints listed (total {total})')
    if total and len(listed) < total * 0.9:
        raise RuntimeError(f'c2c: listed {len(listed)} of {total}; not trusting a short walk')
    fetched = 0
    for doc_id, stamp in listed.items():
        path = os.path.join(docs_dir, f'{doc_id}.json')
        if stamps.get(doc_id) == stamp and os.path.exists(path):
            continue
        try:
            body = _get(f'{C2C_API}/waypoints/{doc_id}')
        except urllib.error.HTTPError:
            continue
        with open(path + '.tmp', 'wb') as f:
            f.write(body)
        os.replace(path + '.tmp', path)
        stamps[doc_id] = stamp
        fetched += 1
        if fetched % 200 == 0:
            write_json(stamps_path, stamps)
            log(f'c2c:   {fetched} documents fetched')
        time.sleep(C2C_PAUSE_S)
    # Documents no longer listed (deleted, merged, re-typed) leave the cache.
    for name in os.listdir(docs_dir):
        if name.endswith('.json') and name[:-5] not in listed:
            os.remove(os.path.join(docs_dir, name))
            stamps.pop(name[:-5], None)
    write_json(stamps_path, stamps)
    log(f'c2c: {fetched} documents fetched, {len(listed) - fetched} unchanged')
