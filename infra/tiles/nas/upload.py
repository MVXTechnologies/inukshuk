#!/usr/bin/env python3
"""Upload a (multi-GB) PMTiles archive to R2 through the tile Worker's
multipart endpoint (`worker/src/index.ts`, `/_upload/{key}`), so the NAS needs
no S3 credentials — only the Worker's upload token.

    upload.py FILE KEY [--host URL] [--token-file PATH] [--part-mb 95] [--jobs 4]

Resumable: finished parts are recorded in FILE.upload.json; rerun the same
command after an interruption and only the missing parts are sent. The live
object is replaced only when every part is in (R2 `complete`).
Standard library only (the NAS has python3, nothing else is installed).
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_HOST = 'https://inukshuk-tiles.marcandre-vigneault-96.workers.dev'


def request(method, url, token, body=None, length=None, timeout=900):
    # Cloudflare's bot check rejects Python's default User-Agent (error 1010).
    headers = {'Authorization': f'Bearer {token}', 'User-Agent': 'inukshuk-tiles-upload/1'}
    if length is not None:
        headers['Content-Length'] = str(length)
    elif body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


class FileSlice:
    """A read-only window onto a file, streamed without loading it in memory."""

    def __init__(self, path, offset, length):
        self.f = open(path, 'rb')
        self.f.seek(offset)
        self.left = length

    def read(self, n=-1):
        if self.left <= 0:
            return b''
        n = self.left if n < 0 else min(n, self.left)
        chunk = self.f.read(n)
        self.left -= len(chunk)
        return chunk

    def close(self):
        self.f.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('key')
    ap.add_argument('--host', default=DEFAULT_HOST)
    ap.add_argument('--token-file', default=os.path.expanduser('~/inukshuk-tiles/.upload-token'))
    ap.add_argument('--part-mb', type=int, default=95)
    ap.add_argument('--jobs', type=int, default=4)
    args = ap.parse_args()

    token = open(args.token_file).read().strip()
    size = os.path.getsize(args.file)
    part_size = args.part_mb * 1024 * 1024
    count = (size + part_size - 1) // part_size
    base = f'{args.host}/_upload/{args.key}'
    state_path = args.file + '.upload.json'

    state = json.load(open(state_path)) if os.path.exists(state_path) else {}
    if state.get('size') != size or state.get('key') != args.key or state.get('partSize') != part_size:
        state = {
            'key': args.key,
            'size': size,
            'partSize': part_size,
            'uploadId': request('POST', f'{base}?action=create', token)['uploadId'],
            'parts': {},
        }
        json.dump(state, open(state_path, 'w'))
    upload_id = state['uploadId']
    print(f'{args.key}: {size / 1e9:.2f} GB in {count} parts, {len(state["parts"])} already done', flush=True)

    def send(n):
        offset = (n - 1) * part_size
        length = min(part_size, size - offset)
        for attempt in range(6):
            body = FileSlice(args.file, offset, length)
            try:
                res = request('PUT', f'{base}?uploadId={upload_id}&part={n}', token, body, length)
                return n, res['etag']
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                wait = 2 ** attempt * 5
                print(f'part {n}: {e}; retry in {wait}s', flush=True)
                time.sleep(wait)
            finally:
                body.close()
        raise RuntimeError(f'part {n} failed 6 times')

    todo = [n for n in range(1, count + 1) if str(n) not in state['parts']]
    started = time.time()
    done_bytes = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for n, etag in pool.map(send, todo):
            state['parts'][str(n)] = etag
            json.dump(state, open(state_path, 'w'))
            done_bytes += min(part_size, size - (n - 1) * part_size)
            rate = done_bytes / max(1, time.time() - started) / 1e6
            print(f'part {n}/{count} ok ({len(state["parts"])}/{count}, {rate:.1f} MB/s)', flush=True)

    parts = [{'partNumber': int(n), 'etag': e} for n, e in sorted(state['parts'].items(), key=lambda kv: int(kv[0]))]
    res = request('POST', f'{base}?action=complete&uploadId={upload_id}', token, json.dumps({'parts': parts}).encode())
    os.remove(state_path)
    print(f'complete: {res}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
