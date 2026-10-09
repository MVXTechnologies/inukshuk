// @ts-check
/**
 * Is this libhermesvm.so the patched Hermes (#648)? Pure logic shared by the
 * Gradle check every Android build runs (verify-hermes.js `packaged`) and by
 * .github/workflows/hermes-android.yml, which builds the patched AAR.
 *
 * Two independent answers:
 * - the GNU build-id must be one of the builds pinned in artifact.json
 *   (every ABI, every variant): anything else — Meta's prebuilt from Maven
 *   Central included — is not the artifact we published;
 * - on arm64-v8a and x86_64, the two ABIs facebook/hermes 73f9af39b1 patches,
 *   hoost_make_fcontext itself must carry the fix: the frame-pointer slot of a
 *   new fiber is zeroed, so GWP-ASan's frame-pointer walk stops there instead
 *   of running off the fiber stack. The bytes are the instructions the patch
 *   adds, as assembled (verified against Meta's unpatched 250829098.0.10
 *   build, whose x86_64 code stores `finish` in the RBP slot: 48 89 48 38,
 *   and pushes it from RBP in the trampoline: 55 ff e3).
 */
const { Buffer } = require('node:buffer');

const { buildId, exportedSymbolBytes, parseElf } = require('./elf');

const FCONTEXT_SYMBOL = 'hoost_make_fcontext';

/** @param {string} hex */
const bytes = (hex) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');

/**
 * @type {Record<string, { patched: Buffer[], unpatched: Buffer[] }>}
 */
const SIGNATURES = {
  x86_64: {
    patched: [
      bytes('48 89 48 10'), // movq %rcx, 0x10(%rax)    finish → R12 slot
      bytes('48 c7 40 38 00 00 00 00'), // movq $0, 0x38(%rax)   RBP slot = 0
      bytes('41 54 ff e3'), // trampoline: push %r12; jmp *%rbx
    ],
    unpatched: [
      bytes('48 89 48 38'), // movq %rcx, 0x38(%rax)    finish → RBP slot
      bytes('55 ff e3'), // trampoline: push %rbp; jmp *%rbx
    ],
  },
  'arm64-v8a': {
    patched: [bytes('1f 48 00 f9')], // str xzr, [x0, #0x90]   FP slot = 0
    unpatched: [],
  },
};

/**
 * @typedef {'patched' | 'unpatched' | 'not-applicable' | 'missing'} FcontextState
 */

/**
 * @param {string | undefined} abi
 * @param {Buffer | undefined} code  hoost_make_fcontext's bytes
 * @returns {FcontextState}
 */
function fcontextState(abi, code) {
  const sig = abi ? SIGNATURES[abi] : undefined;
  if (!sig) return 'not-applicable';
  if (!code) return 'missing';
  const has = (/** @type {Buffer} */ b) => code.indexOf(b) !== -1;
  if (sig.patched.every(has) && !sig.unpatched.some(has)) return 'patched';
  return 'unpatched';
}

/**
 * @typedef {{ abi: string | undefined, buildId: string | undefined, fcontext: FcontextState, size: number }} LibInfo
 */

/**
 * @param {Buffer} buf  a libhermesvm.so
 * @returns {LibInfo}
 */
function describeLib(buf) {
  const elf = parseElf(buf);
  return {
    abi: elf.abi,
    buildId: buildId(elf),
    fcontext: fcontextState(elf.abi, exportedSymbolBytes(elf, FCONTEXT_SYMBOL)),
    size: buf.length,
  };
}

/**
 * Problems with one library, judged on the make_fcontext bytes alone (the
 * build workflow, before any build-id is pinned).
 * @param {LibInfo} info
 * @returns {string[]}
 */
function fcontextProblems(info) {
  if (!info.abi) return ['unknown ELF machine'];
  if (info.fcontext === 'unpatched') return [`${FCONTEXT_SYMBOL} is the UNPATCHED code`];
  if (info.fcontext === 'missing') return [`${FCONTEXT_SYMBOL} is not exported`];
  return [];
}

/**
 * Problems with one PACKAGED library: it must be a pinned build, and patched.
 * @param {LibInfo} info
 * @param {{ buildIds: Record<string, string[]> }} artifact
 * @returns {string[]}
 */
function packagedProblems(info, artifact) {
  const problems = fcontextProblems(info);
  if (!info.abi) return problems;
  const pinned = artifact.buildIds[info.abi] ?? [];
  if (!info.buildId) problems.push('no GNU build-id');
  else if (!pinned.includes(info.buildId)) {
    problems.push(
      `build-id ${info.buildId} is not a patched Hermes build pinned in artifact.json (${
        pinned.length ? pinned.join(', ') : 'none pinned for this ABI'
      })`,
    );
  }
  return problems;
}

module.exports = {
  FCONTEXT_SYMBOL,
  SIGNATURES,
  describeLib,
  fcontextProblems,
  fcontextState,
  packagedProblems,
};
