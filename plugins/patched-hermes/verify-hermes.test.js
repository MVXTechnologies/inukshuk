/**
 * @jest-environment node
 */
const { afterEach, beforeEach, describe, expect, it, jest } = require('@jest/globals');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const artifact = require('./artifact.json');
const { findLibs, main } = require('./verify-hermes');
const { ARM64_PATCHED, X86_64_PATCHED, X86_64_UNPATCHED, hex, makeElf } = require('./testFixtures');

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

describe('verify-hermes', () => {
  it('finds libhermesvm.so recursively, and nothing else', () => {
    const a = put('x86_64', makeElf({ abi: 'x86_64', code: X86_64_PATCHED }));
    writeFileSync(join(dir, 'lib', 'x86_64', 'libother.so'), 'x');
    expect(findLibs(dir)).toEqual([a]);
    expect(findLibs(a)).toEqual([a]);
  });

  it('fails when there is nothing to check (a moved AGP output must not pass)', () => {
    expect(main(['packaged', dir])).toBe(1);
    expect(errors.join('\n')).toContain('No libhermesvm.so found');
  });

  it('expect-patched passes patched 64-bit libraries and ignores 32-bit ones', () => {
    put('x86_64', makeElf({ abi: 'x86_64', code: X86_64_PATCHED, buildId: '01' }));
    put('arm64-v8a', makeElf({ abi: 'arm64-v8a', code: ARM64_PATCHED, buildId: '02' }));
    put('x86', makeElf({ abi: 'x86', code: hex('c3'), buildId: '03' }));
    expect(main(['expect-patched', dir])).toBe(0);
    expect(logs).toHaveLength(3);
  });

  it('expect-patched fails on the prebuilt; expect-unpatched passes it', () => {
    put('x86_64', makeElf({ abi: 'x86_64', code: X86_64_UNPATCHED, buildId: '01' }));
    put('x86', makeElf({ abi: 'x86', code: hex('c3'), buildId: '03' }));
    expect(main(['expect-patched', dir])).toBe(1);
    expect(main(['expect-unpatched', dir])).toBe(0);
  });

  it('expect-unpatched fails on the patched build, or with no 64-bit library at all', () => {
    const p = put('x86_64', makeElf({ abi: 'x86_64', code: X86_64_PATCHED, buildId: '01' }));
    expect(main(['expect-unpatched', dir])).toBe(1);
    rmSync(p);
    put('x86', makeElf({ abi: 'x86', code: hex('c3'), buildId: '03' }));
    expect(main(['expect-unpatched', dir])).toBe(1);
  });

  it('packaged checks the build-ids pinned in artifact.json', () => {
    const pinned = Object.entries(artifact.buildIds)[0];
    put('x86_64', makeElf({ abi: 'x86_64', code: X86_64_PATCHED, buildId: 'feedface' }));
    expect(main(['packaged', dir])).toBe(1);
    expect(errors.join('\n')).toContain('not a patched Hermes build pinned in artifact.json');
    if (pinned) {
      const [abi, ids] = pinned;
      rmSync(join(dir, 'lib'), { recursive: true });
      const code = abi === 'arm64-v8a' ? ARM64_PATCHED : X86_64_PATCHED;
      put(abi, makeElf({ abi: /** @type {any} */ (abi), code, buildId: ids[0] }));
      expect(main(['packaged', dir])).toBe(0);
    }
  });

  it('describe prints JSON; bad usage is exit 2', () => {
    const p = put('x86_64', makeElf({ abi: 'x86_64', code: X86_64_PATCHED, buildId: '01' }));
    expect(main(['describe', dir])).toBe(0);
    expect(JSON.parse(logs.join('\n'))[p]).toMatchObject({ abi: 'x86_64', fcontext: 'patched' });
    expect(main(['describe'])).toBe(2);
    expect(main(['bogus', dir])).toBe(2);
  });
});
