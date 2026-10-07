import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

import {
  badgeText,
  encodePng,
  MAX_COUNT,
  MIN_COUNT,
  OUT_DIR,
  renderAll,
  requireTable,
  TABLE_PATH,
} from './badges.mjs';

// The committed trail-photo badges (#587) are exactly what the script makes:
// change the design in the script, re-run it, and commit the result.

test('the committed badge images match the script', () => {
  const files = renderAll();
  assert.equal(files.size, MAX_COUNT - MIN_COUNT + 2);
  const committed = readdirSync(OUT_DIR)
    .filter((n) => n.endsWith('.png'))
    .sort();
  assert.deepEqual(committed, [...files.keys()].sort());
  for (const [name, bytes] of files) {
    // Pixels, not bytes: another zlib build may compress the same rows differently.
    const committedPng = decode(readFileSync(join(OUT_DIR, name)));
    const made = decode(bytes);
    assert.ok(committedPng.header.equals(made.header), `${name}: size changed`);
    assert.ok(committedPng.rows.equals(made.rows), `${name} is stale`);
  }
});

/** IHDR and the inflated (filtered) rows of a PNG. */
function decode(png) {
  let at = 8;
  let header = Buffer.alloc(0);
  const idat = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') header = Buffer.from(data);
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  return { header, rows: inflateSync(Buffer.concat(idat)) };
}

test('the require table matches the script', () => {
  assert.equal(readFileSync(TABLE_PATH, 'utf8'), requireTable());
});

test('a hundred and more read 99+', () => {
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(badgeText(4000), '99+');
});

test('writes a valid PNG header', () => {
  const png = encodePng({ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) });
  assert.deepEqual([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
  assert.equal(png.readUInt32BE(16), 1);
});
