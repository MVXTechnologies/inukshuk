/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');
const { Buffer } = require('node:buffer');

const { buildId, exportedSymbolBytes, parseElf } = require('./elf');
const { X86_64_UNPATCHED, hex, makeElf } = require('./testFixtures');

describe('parseElf', () => {
  it('reads a 64-bit library: ABI, build-id, exported function bytes', () => {
    const elf = parseElf(
      makeElf({
        abi: 'x86_64',
        code: X86_64_UNPATCHED,
        buildId: '499b43a64a8d7cd6702459b78ebbbc9e1626e0c7',
      }),
    );
    expect(elf.is64).toBe(true);
    expect(elf.abi).toBe('x86_64');
    expect(buildId(elf)).toBe('499b43a64a8d7cd6702459b78ebbbc9e1626e0c7');
    expect(exportedSymbolBytes(elf, 'hoost_make_fcontext')).toEqual(X86_64_UNPATCHED);
  });

  it('reads a 32-bit library, clearing the Thumb bit of a function address', () => {
    const code = hex('00 48 2d e9 0d b0 a0 e1 00 88 bd e8');
    const elf = parseElf(makeElf({ abi: 'armeabi-v7a', code, buildId: 'abcd1234', thumb: true }));
    expect(elf.is64).toBe(false);
    expect(elf.abi).toBe('armeabi-v7a');
    expect(buildId(elf)).toBe('abcd1234');
    expect(exportedSymbolBytes(elf, 'hoost_make_fcontext')).toEqual(code);
  });

  it('maps every Android ABI', () => {
    const code = hex('c3');
    expect(parseElf(makeElf({ abi: 'x86', code })).abi).toBe('x86');
    expect(parseElf(makeElf({ abi: 'arm64-v8a', code })).abi).toBe('arm64-v8a');
  });

  it('reads a size-less symbol up to the fallback size, clamped to its section', () => {
    const code = Buffer.alloc(0x100, 0x90);
    const elf = parseElf(makeElf({ abi: 'x86_64', code, symbolSize: 0, symbolOffset: 0xf0 }));
    expect(exportedSymbolBytes(elf, 'hoost_make_fcontext')?.length).toBe(0x10);
    expect(exportedSymbolBytes(elf, 'hoost_make_fcontext', 4)?.length).toBe(4);
  });

  it('returns undefined for a symbol the library does not export, or no build-id', () => {
    const elf = parseElf(makeElf({ abi: 'x86_64', code: hex('c3') }));
    expect(exportedSymbolBytes(elf, 'hoost_jump_fcontext')).toBeUndefined();
    expect(buildId(elf)).toBeUndefined();
  });

  it('rejects what is not a little-endian ELF', () => {
    expect(() => parseElf(Buffer.alloc(64))).toThrow('not an ELF file');
    const elf = makeElf({ abi: 'x86_64', code: hex('c3') });
    const big = Buffer.from(elf);
    big[5] = 2;
    expect(() => parseElf(big)).toThrow('big-endian');
    const weird = Buffer.from(elf);
    weird[4] = 3;
    expect(() => parseElf(weird)).toThrow('unknown ELF class');
    const noSections = Buffer.from(elf);
    noSections.writeUInt16LE(0, 0x3c);
    expect(() => parseElf(noSections)).toThrow('no section headers');
    expect(() => parseElf(elf.subarray(0, elf.length - 8))).toThrow('out of range');
  });
});
