/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');

const { describeLib, fiberProblems, packagedProblems } = require('./hermesCheck');
const { X86_64_UNPATCHED, hex, makeElf } = require('./testFixtures');

const withFibers = (/** @type {Partial<Parameters<typeof makeElf>[0]>} */ o) =>
  describeLib(makeElf({ abi: 'x86_64', code: X86_64_UNPATCHED, ...o }));
const fiberFree = (/** @type {Partial<Parameters<typeof makeElf>[0]>} */ o) =>
  describeLib(makeElf({ abi: 'x86_64', code: hex('c3'), symbol: 'hermes_other', ...o }));

describe('describeLib', () => {
  it('sees fibers when the library exports a hoost_*_fcontext function', () => {
    expect(withFibers({ buildId: 'aa' })).toMatchObject({ abi: 'x86_64', fibers: 'present' });
    expect(withFibers({ symbol: 'hoost_jump_fcontext' }).fibers).toBe('present');
    expect(withFibers({ symbol: 'hoost_ontop_fcontext' }).fibers).toBe('present');
  });

  it('sees none in a library without them', () => {
    expect(fiberFree({ buildId: 'bb' })).toMatchObject({ buildId: 'bb', fibers: 'absent' });
  });
});

describe('checks', () => {
  const artifact = { buildIds: { x86_64: ['aa11'], 'armeabi-v7a': ['cc33'] } };

  it('passes a fiber-free library whose build-id is pinned', () => {
    const info = fiberFree({ buildId: 'aa11' });
    expect(fiberProblems(info)).toEqual([]);
    expect(packagedProblems(info, artifact)).toEqual([]);
  });

  it("fails Meta's prebuilt (fibers, unpinned build-id) on every ABI, 32-bit included", () => {
    const info = withFibers({ buildId: '499b43a6' });
    expect(packagedProblems(info, artifact)).toEqual([
      'Boost.Context fibers are linked in (hoost_make_fcontext is exported)',
      'build-id 499b43a6 is not a Hermes build pinned in artifact.json (aa11)',
    ]);
    const arm = withFibers({ abi: 'armeabi-v7a', buildId: 'cc33' });
    expect(fiberProblems(arm)).toHaveLength(1);
  });

  it('fails an unpinned build-id, or none, even without fibers', () => {
    expect(packagedProblems(fiberFree({ abi: 'x86', buildId: 'dd44' }), artifact)).toEqual([
      'build-id dd44 is not a Hermes build pinned in artifact.json (none pinned for this ABI)',
    ]);
    expect(packagedProblems(fiberFree({}), artifact)).toEqual(['no GNU build-id']);
  });

  it('fails an unknown machine', () => {
    const elf = makeElf({ abi: 'x86_64', code: hex('c3') });
    elf.writeUInt16LE(243, 18); // RISC-V
    expect(packagedProblems(describeLib(elf), artifact)).toEqual(['unknown ELF machine']);
  });
});
