/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');
const { Buffer } = require('node:buffer');

const { describeLib, fcontextProblems, fcontextState, packagedProblems } = require('./hermesCheck');
const {
  ARM64_PATCHED,
  ARM64_UNPATCHED,
  X86_64_PATCHED,
  X86_64_UNPATCHED,
  hex,
  makeElf,
} = require('./testFixtures');

describe('fcontextState', () => {
  it("recognises Meta's unpatched 250829098.0.10 code on both 64-bit ABIs", () => {
    expect(fcontextState('x86_64', X86_64_UNPATCHED)).toBe('unpatched');
    expect(fcontextState('arm64-v8a', ARM64_UNPATCHED)).toBe('unpatched');
  });

  it('recognises the patched code', () => {
    expect(fcontextState('x86_64', X86_64_PATCHED)).toBe('patched');
    expect(fcontextState('arm64-v8a', ARM64_PATCHED)).toBe('patched');
  });

  it('calls a half-patched x86_64 function unpatched', () => {
    // RBP slot zeroed, but the trampoline still pushes RBP.
    const half = Buffer.from(X86_64_PATCHED);
    half.set(hex('90 55 ff e3'), half.indexOf(hex('41 54 ff e3')));
    expect(fcontextState('x86_64', half)).toBe('unpatched');
  });

  it('has nothing to say about the 32-bit ABIs (the upstream fix does not touch them)', () => {
    expect(fcontextState('armeabi-v7a', hex('00'))).toBe('not-applicable');
    expect(fcontextState('x86', undefined)).toBe('not-applicable');
    expect(fcontextState(undefined, hex('00'))).toBe('not-applicable');
  });

  it('reports a 64-bit library that does not export the function', () => {
    expect(fcontextState('x86_64', undefined)).toBe('missing');
  });
});

describe('describeLib + checks', () => {
  const lib = (/** @type {Parameters<typeof makeElf>[0]} */ o) => describeLib(makeElf(o));
  const artifact = { buildIds: { x86_64: ['aa11'], 'armeabi-v7a': ['cc33'] } };

  it('passes a patched library whose build-id is pinned', () => {
    const info = lib({ abi: 'x86_64', code: X86_64_PATCHED, buildId: 'aa11' });
    expect(info).toMatchObject({ abi: 'x86_64', buildId: 'aa11', fcontext: 'patched' });
    expect(fcontextProblems(info)).toEqual([]);
    expect(packagedProblems(info, artifact)).toEqual([]);
  });

  it("fails Meta's prebuilt: unpinned build-id and unpatched code", () => {
    const info = lib({ abi: 'x86_64', code: X86_64_UNPATCHED, buildId: '499b43a6' });
    expect(fcontextProblems(info)).toEqual(['hoost_make_fcontext is the UNPATCHED code']);
    expect(packagedProblems(info, artifact)).toEqual([
      'hoost_make_fcontext is the UNPATCHED code',
      'build-id 499b43a6 is not a patched Hermes build pinned in artifact.json (aa11)',
    ]);
  });

  it('judges a 32-bit library on its build-id alone', () => {
    const pinned = lib({ abi: 'armeabi-v7a', code: hex('00'), buildId: 'cc33' });
    expect(packagedProblems(pinned, artifact)).toEqual([]);
    const other = lib({ abi: 'x86', code: hex('00'), buildId: 'dd44' });
    expect(packagedProblems(other, artifact)).toEqual([
      'build-id dd44 is not a patched Hermes build pinned in artifact.json (none pinned for this ABI)',
    ]);
  });

  it('fails a library without a build-id, or with a missing function', () => {
    const noId = lib({ abi: 'x86_64', code: X86_64_PATCHED });
    expect(packagedProblems(noId, artifact)).toEqual(['no GNU build-id']);
    const noFn = lib({
      abi: 'arm64-v8a',
      code: ARM64_PATCHED,
      symbol: 'other_fn',
      buildId: 'aa11',
    });
    expect(fcontextProblems(noFn)).toEqual(['hoost_make_fcontext is not exported']);
  });

  it('fails an unknown machine', () => {
    const elf = makeElf({ abi: 'x86_64', code: hex('c3') });
    elf.writeUInt16LE(243, 18); // RISC-V
    const info = describeLib(elf);
    expect(packagedProblems(info, artifact)).toEqual(['unknown ELF machine']);
  });
});
