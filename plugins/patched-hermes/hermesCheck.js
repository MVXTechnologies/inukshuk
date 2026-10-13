// @ts-check
/**
 * Is this libhermesvm.so the fiber-free Hermes we build (#648)? Pure logic
 * shared by the Gradle check every Android build runs (verify-hermes.js
 * `packaged`) and by .github/workflows/hermes-android.yml.
 *
 * Two independent answers:
 * - the GNU build-id must be one of the builds pinned in artifact.json
 *   (every ABI, every variant): anything else, Meta's prebuilt from Maven
 *   Central included, is not the artifact we published;
 * - the library must not contain Boost.Context fibers at all: it must not
 *   export hoost_make_fcontext / hoost_jump_fcontext / hoost_ontop_fcontext.
 *   With fibers, Hermes runs its compiler (eval, lazy compilation) on an
 *   mmap'd fiber stack. bionic's android_unsafe_frame_pointer_chase, which
 *   GWP-ASan calls on every sampled free(), bounds its walk by the current
 *   THREAD's stack, a bound that says nothing about a fiber stack; and on
 *   x86_64 Hermes uses RBP as a general register, so the walk follows garbage
 *   until it reads past a mapping (SEGV_ACCERR). Built without fibers, the
 *   compiler runs on a real thread whose stack bounds the walk.
 */
const { buildId, exportedSymbolBytes, parseElf } = require('./elf');

const FIBER_SYMBOLS = ['hoost_make_fcontext', 'hoost_jump_fcontext', 'hoost_ontop_fcontext'];

/**
 * @typedef {'absent' | 'present'} FiberState
 * @typedef {{ abi: string | undefined, buildId: string | undefined, fibers: FiberState, size: number }} LibInfo
 */

/**
 * @param {Buffer} buf  a libhermesvm.so
 * @returns {LibInfo}
 */
function describeLib(buf) {
  const elf = parseElf(buf);
  const present = FIBER_SYMBOLS.some((s) => exportedSymbolBytes(elf, s) !== undefined);
  return {
    abi: elf.abi,
    buildId: buildId(elf),
    fibers: present ? 'present' : 'absent',
    size: buf.length,
  };
}

/**
 * Problems with one library, judged on its fibers alone (the build workflow,
 * before any build-id is pinned).
 * @param {LibInfo} info
 * @returns {string[]}
 */
function fiberProblems(info) {
  if (!info.abi) return ['unknown ELF machine'];
  if (info.fibers === 'present') {
    return [`Boost.Context fibers are linked in (${FIBER_SYMBOLS[0]} is exported)`];
  }
  return [];
}

/**
 * Problems with one PACKAGED library: it must be a pinned build, fiber-free.
 * @param {LibInfo} info
 * @param {{ buildIds: Record<string, string[]> }} artifact
 * @returns {string[]}
 */
function packagedProblems(info, artifact) {
  const problems = fiberProblems(info);
  if (!info.abi) return problems;
  const pinned = artifact.buildIds[info.abi] ?? [];
  if (!info.buildId) problems.push('no GNU build-id');
  else if (!pinned.includes(info.buildId)) {
    problems.push(
      `build-id ${info.buildId} is not a Hermes build pinned in artifact.json (${
        pinned.length ? pinned.join(', ') : 'none pinned for this ABI'
      })`,
    );
  }
  return problems;
}

module.exports = { FIBER_SYMBOLS, describeLib, fiberProblems, packagedProblems };
