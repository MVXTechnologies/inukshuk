/**
 * @jest-environment node
 */
const { afterEach, beforeEach, describe, expect, it, jest } = require('@jest/globals');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const artifact = require('./artifact.json');
const { findLibs, main } = require('./verify-hermes');
const { X86_64_UNPATCHED, hex, makeElf } = require('./testFixtures');

let dir = '';
/** @type {string[]} */
let errors = [];
/** @type {string[]} */
let logs = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-hermes-'));
  errors = [];
  logs = [];
  jest.spyOn(console, 'error').mockImplementation((m) => void errors.push(String(m)));
  jest.spyOn(console, 'log').mockImplementation((m) => void logs.push(String(m)));
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** @param {string} abi @param {Buffer} elf */
function put(abi, elf) {
  mkdirSync(join(dir, 'lib', abi), { recursive: true });
  const p = join(dir, 'lib', abi, 'libhermesvm.so');
  writeFileSync(p, elf);
  return p;
}
const fibers = (/** @type {any} */ abi, /** @type {string} */ id) =>
  makeElf({ abi, code: X86_64_UNPATCHED, buildId: id });
const noFibers = (/** @type {any} */ abi, /** @type {string} */ id) =>
  makeElf({ abi, code: hex('c3'), symbol: 'hermes_other', buildId: id });

describe('verify-hermes', () => {
  it('finds libhermesvm.so recursively, and nothing else', () => {
    const a = put('x86_64', noFibers('x86_64', '01'));
    writeFileSync(join(dir, 'lib', 'x86_64', 'libother.so'), 'x');
    expect(findLibs(dir)).toEqual([a]);
    expect(findLibs(a)).toEqual([a]);
  });

  it('fails when there is nothing to check (a moved AGP output must not pass)', () => {
    expect(main(['packaged', dir])).toBe(1);
    expect(errors.join('\n')).toContain('No libhermesvm.so found');
  });

  it('expect-fiber-free passes fiber-free libraries of every ABI', () => {
    for (const abi of ['x86_64', 'arm64-v8a', 'x86', 'armeabi-v7a']) put(abi, noFibers(abi, '01'));
    expect(main(['expect-fiber-free', dir])).toBe(0);
    expect(logs).toHaveLength(4);
  });

  it("expect-fiber-free fails Meta's prebuilt; expect-fibers passes it", () => {
    put('x86_64', fibers('x86_64', '01'));
    put('x86', fibers('x86', '03'));
    expect(main(['expect-fiber-free', dir])).toBe(1);
    expect(main(['expect-fibers', dir])).toBe(0);
  });

  it('expect-fibers fails a fiber-free build (the negative control can fail)', () => {
    put('x86_64', fibers('x86_64', '01'));
    put('x86', noFibers('x86', '03'));
    expect(main(['expect-fibers', dir])).toBe(1);
  });

  it('packaged checks the build-ids pinned in artifact.json', () => {
    put('x86_64', noFibers('x86_64', 'feedface'));
    expect(main(['packaged', dir])).toBe(1);
    expect(errors.join('\n')).toContain('not a Hermes build pinned in artifact.json');
    /** @type {Record<string, string[]>} */
    const ids = artifact.buildIds;
    const pinned = Object.entries(ids)[0];
    if (pinned) {
      const [abi, list] = pinned;
      rmSync(join(dir, 'lib'), { recursive: true });
      put(abi, noFibers(abi, list[0] ?? ''));
      expect(main(['packaged', dir])).toBe(0);
    }
  });

  it('describe prints JSON; bad usage is exit 2', () => {
    const p = put('x86_64', noFibers('x86_64', '01'));
    expect(main(['describe', dir])).toBe(0);
    expect(JSON.parse(logs.join('\n'))[p]).toMatchObject({ abi: 'x86_64', fibers: 'absent' });
    expect(main(['describe'])).toBe(2);
    expect(main(['bogus', dir])).toBe(2);
  });
});
