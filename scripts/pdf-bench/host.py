#!/usr/bin/env python3
"""Host side of the PDF time-to-sharp benchmark (see src/features/map/hooks/usePdfBench.ts).

Serves the corpus (with HTTP Range, so the app downloads like from any
server), the run plan, and collects what the app posts back:

  GET  /corpus/<file>        a corpus PDF
  GET  /plan.json            the plan for the current run
  POST /log, /result, /done  JSON lines appended to <out>/<runId>/results.jsonl
  POST /tile?...             a displayed raster (JSON, base64 PNG), saved as a PNG + meta
  GET  /shot?...             runs `adb exec-out screencap` (Android) or
                             `xcrun simctl io <udid> screenshot` (iOS), saves the PNG

Usage:
  host.py --corpus DIR --out DIR --plan plan.json [--port 8765]
          [--android SERIAL | --ios UDID]

The app reaches it at http://127.0.0.1:<port> (Android: `adb reverse tcp:<port> tcp:<port>`).
"""
import argparse
import json
import os
import re
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None
LOCK = threading.Lock()
DONE = threading.Event()


def safe(name):
    return re.sub(r'[^\w.+-]+', '_', name)[:160]


def run_dir(run_id):
    d = os.path.join(ARGS.out, safe(run_id))
    os.makedirs(d, exist_ok=True)
    return d


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):  # quiet
        pass

    def _send(self, code, body=b'', ctype='application/octet-stream', extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == '/plan.json':
            plan = json.load(open(ARGS.plan))
            return self._send(200, json.dumps(plan).encode(), 'application/json')
        if u.path.startswith('/corpus/'):
            return self._file(os.path.join(ARGS.corpus, os.path.basename(urllib.parse.unquote(u.path))))
        if u.path == '/shot':
            d = os.path.join(run_dir(q.get('run', 'run')), 'shots')
            os.makedirs(d, exist_ok=True)
            out = os.path.join(d, safe(f"{q.get('map', '')}__{q.get('step', '')}") + '.png')
            if ARGS.android:
                with open(out, 'wb') as f:
                    subprocess.run(['adb', '-s', ARGS.android, 'exec-out', 'screencap', '-p'], stdout=f, timeout=30)
            elif ARGS.ios:
                subprocess.run(['xcrun', 'simctl', 'io', ARGS.ios, 'screenshot', out], timeout=30,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self._send(200, b'ok', 'text/plain')
        return self._send(404, b'not found', 'text/plain')

    def _file(self, path):
        if not os.path.isfile(path):
            return self._send(404, b'missing', 'text/plain')
        size = os.path.getsize(path)
        rng = self.headers.get('Range')
        if rng:
            m = re.match(r'bytes=(\d*)-(\d*)', rng)
            start = int(m.group(1)) if m.group(1) else 0
            end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
            with open(path, 'rb') as f:
                f.seek(start)
                body = f.read(end - start + 1)
            return self._send(206, body, 'application/pdf',
                              {'Content-Range': f'bytes {start}-{end}/{size}', 'Accept-Ranges': 'bytes'})
        self.send_response(200)
        self.send_header('Content-Type', 'application/pdf')
        self.send_header('Content-Length', str(size))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        if self.command == 'HEAD':
            return
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n)
        if u.path in ('/log', '/result', '/done'):
            data = json.loads(body or b'{}')
            data['_kind'] = u.path[1:]
            data['_t'] = time.time()
            # Host load (1-min average): the emulator shares the machine, and a
            # busy host slows every render. Reported with the numbers.
            data['_load'] = round(os.getloadavg()[0], 1)
            with LOCK:
                with open(os.path.join(run_dir(data.get('runId', 'run')), 'results.jsonl'), 'a') as f:
                    f.write(json.dumps(data) + '\n')
            if u.path == '/log':
                print('LOG', data.get('msg'), flush=True)
            if u.path == '/done':
                print('DONE', data, flush=True)
                DONE.set()
            return self._send(200, b'ok', 'text/plain')
        if u.path == '/tile':
            import base64
            data = json.loads(body or b'{}')
            png = base64.b64decode(data.pop('png64', '') or b'')
            d = os.path.join(run_dir(q.get('run', 'run')), 'tiles', safe(q.get('map', '')))
            os.makedirs(d, exist_ok=True)
            base = safe(f"{q.get('step', '')}__{q.get('id', '')}")
            if png:
                open(os.path.join(d, base + '.png'), 'wb').write(png)
            data.update({'step': q.get('step'), 'map': q.get('map')})
            json.dump(data, open(os.path.join(d, base + '.json'), 'w'))
            return self._send(200, b'ok', 'text/plain')
        return self._send(404, b'not found', 'text/plain')


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument('--corpus', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--plan', required=True)
    p.add_argument('--port', type=int, default=8765)
    p.add_argument('--android')
    p.add_argument('--ios')
    p.add_argument('--exit-on-done', action='store_true')
    ARGS = p.parse_args()
    srv = ThreadingHTTPServer(('127.0.0.1', ARGS.port), Handler)
    print(f'listening on {ARGS.port}', flush=True)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        while True:
            if ARGS.exit_on_done and DONE.wait(1):
                time.sleep(1)
                break
            time.sleep(1)
    finally:
        srv.shutdown()


if __name__ == '__main__':
    main()
