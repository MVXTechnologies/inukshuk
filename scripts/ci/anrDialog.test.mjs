import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { center, findAnrDialog, parseNodes } from './anrDialog.mjs';

const fixture = (name) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

// anr-dialog.maestro.json is the hierarchy Maestro captured in run
// 37914205449 (extensions shard): "Pixel Launcher isn't responding" over the
// app. The .xml fixtures re-express the same nodes in the shape of
// `uiautomator dump`, which is what the runner reads on the device.
describe('findAnrDialog', () => {
  it('finds the real captured launcher ANR dialog (Maestro JSON)', () => {
    const found = findAnrDialog(fixture('anr-dialog.maestro.json'));
    assert.ok(found);
    assert.equal(found.title, "Pixel Launcher isn't responding");
    assert.equal(found.ownApp, false);
    // "Close app" bounds [70,1170][1010,1296]
    assert.deepEqual(found.close, [540, 1233]);
    assert.deepEqual(found.wait, [540, 1359]);
  });

  it('finds the same dialog in uiautomator XML, entity-decoded', () => {
    const found = findAnrDialog(fixture('anr-dialog.uiautomator.xml'));
    assert.ok(found);
    assert.equal(found.title, "Pixel Launcher isn't responding");
    assert.equal(found.ownApp, false);
    assert.deepEqual(found.close, [540, 1233]);
  });

  it('flags an ANR of the app under test so it is never closed', () => {
    const found = findAnrDialog(fixture('anr-dialog-own-app.uiautomator.xml'));
    assert.ok(found);
    assert.equal(found.title, "Inukshuk isn't responding");
    assert.equal(found.ownApp, true);
  });

  it('does not treat a longer app name as the app', () => {
    const found = findAnrDialog(fixture('anr-dialog.uiautomator.xml'), 'Pixel');
    assert.equal(found?.ownApp, true, 'prefix + space is the app label match');
    assert.equal(findAnrDialog(fixture('anr-dialog.uiautomator.xml'), 'Pix')?.ownApp, false);
  });

  it('returns null for the same capture without the dialog', () => {
    assert.equal(findAnrDialog(fixture('no-dialog.maestro.json')), null);
  });

  it('returns null for a normal app screen', () => {
    assert.equal(findAnrDialog(fixture('app-screen.uiautomator.xml')), null);
  });

  it('returns null for empty or hierarchy-less input', () => {
    assert.equal(findAnrDialog(''), null);
    assert.equal(findAnrDialog('<hierarchy rotation="0"></hierarchy>'), null);
  });
});

describe('helpers', () => {
  it('computes bounds centres and rejects malformed bounds', () => {
    assert.deepEqual(center('[0,0][10,20]'), [5, 10]);
    assert.equal(center('nope'), null);
    assert.equal(center(undefined), null);
  });

  it('parses XML attributes', () => {
    const nodes = parseNodes('<node text="a &amp; b" resource-id="x:id/y" bounds="[1,1][3,3]" />');
    assert.deepEqual(nodes[0], { text: 'a & b', 'resource-id': 'x:id/y', bounds: '[1,1][3,3]' });
  });
});
