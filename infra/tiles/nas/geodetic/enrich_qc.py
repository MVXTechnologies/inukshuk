#!/usr/bin/env python3
"""Polite, resumable harvest of the Québec MRNF datasheets (DESIGN.md §5.1b).

The open bulk layer has only ID, type and status (±2 m). Heights, monument,
last inspection and the precise position exist only in the per-point PDF
("fiche signalétique"). This job fetches each live mark's sheet once, keeps
its extracted text and parsed fields — never the PDF — and moves on.

    enrich_qc.py harvest STATE_DIR QC_RAW_DIR [--interval 2.5] [--limit N]
    enrich_qc.py reparse STATE_DIR          # re-run parse_fiche over the kept texts
    enrich_qc.py status  STATE_DIR QC_RAW_DIR

STATE_DIR holds:
    fiches.jsonl      one line per fetched sheet: {m, etat, at, datum, ok, f: {parsed}}
                      (last line per matricule wins)
    texts.jsonl.gz    {m, datum, text} — appended gzip members, for reparse
    progress.json     counts + rate + ETA, rewritten every 25 sheets
    STOP              create it to stop cleanly after the current sheet

Politeness: one sheet at a time, `--interval` seconds between request starts
(plus the server's own ~1–3 s), exponential backoff (1 min → 30 min) on
errors, 429 or 5xx, an identifying User-Agent. Order: nearest Québec City
first, so the populated south fills in early; a later run only fetches new
matricules and those whose bulk status changed (incremental refresh).
"""
import argparse
import gzip
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USER_AGENT, log, ssl_context  # noqa: E402
from qc import SHEET_URL, bulk_rows, parse_fiche, status_of  # noqa: E402

LIVE = ('ok', 'damaged', 'unknown')
ORIGIN = (46.8139, -71.2080)  # Québec City


def load_done(state_dir):
    """matricule → last fiches.jsonl entry."""
    done = {}
    path = os.path.join(state_dir, 'fiches.jsonl')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue  # a line cut by a crash
                done[e['m']] = e
    return done


def todo_list(raw_dir, done):
    """Live matricules still to fetch, nearest Québec City first."""
    out = []
    for r in bulk_rows(raw_dir):
        if status_of(r['etat'], r['typeRaw']) not in LIVE or not r['matricule']:
            continue
        prev = done.get(r['matricule'])
        if prev and prev.get('ok') and prev.get('etat') == r['etat']:
            continue
        if prev and not prev.get('ok') and prev.get('tries', 1) >= 3 and prev.get('etat') == r['etat']:
            continue
        d = math.hypot(r['lat'] - ORIGIN[0], (r['lng'] - ORIGIN[1]) * math.cos(math.radians(ORIGIN[0])))
        out.append((d, r['matricule'], r['etat']))
    out.sort()
    return [(m, etat) for _, m, etat in out]


class Throttled(Exception):
    pass


def fetch_text(matricule, datum, ctx):
    """The sheet's extracted text, or None when the server answers with no PDF."""
    import pypdf  # noqa: PLC0415 — only the harvester needs it

    url = SHEET_URL.format(id=matricule, datum=datum)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=90, context=ctx) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 429 or e.code >= 500:
            raise Throttled(f'HTTP {e.code}') from e
        return None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        raise Throttled(str(e)) from e
    if not data.startswith(b'%PDF'):
        return None
    reader = pypdf.PdfReader(io.BytesIO(data))
    return '\n'.join(p.extract_text() or '' for p in reader.pages[:2])


def harvest(state_dir, raw_dir, interval, limit):
    os.makedirs(state_dir, exist_ok=True)
    done = load_done(state_dir)
    todo = todo_list(raw_dir, done)
    if limit:
        todo = todo[:limit]
    total_live = sum(1 for e in done.values() if e.get('ok')) + len(todo)
    log(f'qc harvest: {len(todo)} to fetch, {len(done)} already in {state_dir}')
    ctx = ssl_context()
    stop = os.path.join(state_dir, 'STOP')
    started, fetched, backoff = time.time(), 0, 60
    with open(os.path.join(state_dir, 'fiches.jsonl'), 'a', encoding='utf-8') as out:
        for i, (mat, etat) in enumerate(todo):
            if os.path.exists(stop):
                log('qc harvest: STOP file found; stopping')
                break
            t0 = time.time()
            while True:
                try:
                    text, datum = fetch_text(mat, 2, ctx), 2
                    if text is None:
                        time.sleep(interval)
                        text, datum = fetch_text(mat, 1, ctx), 1
                    backoff = 60
                    break
                except Throttled as e:
                    log(f'qc harvest: {mat}: {e}; backing off {backoff}s')
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 1800)
            prev = done.get(mat) or {}
            entry = {'m': mat, 'etat': etat, 'at': time.strftime('%Y-%m-%d'), 'datum': datum,
                     'ok': text is not None}
            if text is not None:
                entry['f'] = parse_fiche(text)
                with gzip.open(os.path.join(state_dir, 'texts.jsonl.gz'), 'at', encoding='utf-8') as tz:
                    tz.write(json.dumps({'m': mat, 'datum': datum, 'text': text}, ensure_ascii=False) + '\n')
            else:
                entry['tries'] = prev.get('tries', 0) + 1
            out.write(json.dumps(entry, ensure_ascii=False) + '\n')
            out.flush()
            done[mat] = entry
            fetched += 1
            if fetched % 25 == 0 or i == len(todo) - 1:
                write_progress(state_dir, done, total_live, len(todo) - i - 1, started, fetched)
            time.sleep(max(0.0, interval - (time.time() - t0)))
    write_progress(state_dir, done, total_live, 0, started, fetched)


def write_progress(state_dir, done, total_live, left, started, fetched):
    elapsed = time.time() - started
    rate = fetched / elapsed if elapsed > 0 else 0
    ok = sum(1 for e in done.values() if e.get('ok'))
    eta_h = left / rate / 3600 if rate else None
    p = {'updated': time.strftime('%Y-%m-%dT%H:%M:%S'), 'parsed': ok, 'live': total_live,
         'left': left, 'perHour': round(rate * 3600), 'etaHours': eta_h and round(eta_h, 1)}
    tmp = os.path.join(state_dir, 'progress.json.tmp')
    json.dump(p, open(tmp, 'w'))
    os.replace(tmp, os.path.join(state_dir, 'progress.json'))
    log(f"qc harvest: {ok}/{total_live} sheets, {left} left, {p['perHour']}/h, ETA {p['etaHours']} h")


def load_fiches(state_dir):
    """matricule → parsed fields, for the normalizer (only successful sheets).

    Parsed from the kept TEXTS with today's parse_fiche, not from the fields
    stored at harvest time: a parser fix reaches every sheet at the next
    build, without re-fetching anything (and without rewriting fiches.jsonl
    under the running harvester)."""
    ok = {m for m, e in load_done(state_dir).items() if e.get('ok')}
    out = {}
    path = os.path.join(state_dir, 'texts.jsonl.gz')
    if not os.path.exists(path):
        return out
    try:
        with gzip.open(path, 'rt', encoding='utf-8') as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get('m') in ok:
                    out[e['m']] = parse_fiche(e['text'])
    except (EOFError, OSError):
        pass  # the harvester is mid-append: what was read so far is fine
    return out


def reparse(state_dir):
    texts = {}
    with gzip.open(os.path.join(state_dir, 'texts.jsonl.gz'), 'rt', encoding='utf-8') as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            texts[e['m']] = e
    done = load_done(state_dir)
    path = os.path.join(state_dir, 'fiches.jsonl')
    with open(path + '.tmp', 'w', encoding='utf-8') as out:
        for m, e in done.items():
            if m in texts:
                e['f'] = parse_fiche(texts[m]['text'])
            out.write(json.dumps(e, ensure_ascii=False) + '\n')
    os.replace(path + '.tmp', path)
    log(f'qc reparse: {len(texts)} sheets re-parsed')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=('harvest', 'reparse', 'status'))
    ap.add_argument('state_dir')
    ap.add_argument('raw_dir', nargs='?')
    ap.add_argument('--interval', type=float, default=2.5)
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    if a.cmd == 'harvest':
        harvest(a.state_dir, a.raw_dir, a.interval, a.limit)
    elif a.cmd == 'reparse':
        reparse(a.state_dir)
    else:
        done = load_done(a.state_dir)
        print(json.dumps({'fetched': len(done), 'ok': sum(1 for e in done.values() if e.get('ok')),
                          'todo': len(todo_list(a.raw_dir, done))}))


if __name__ == '__main__':
    main()
