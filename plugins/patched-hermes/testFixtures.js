// @ts-check
/**
 * Test-only: minimal ELF shared objects (one code section exporting one
 * symbol, a GNU build-id note) and the make_fcontext bytes the checks look at.
 */
const { Buffer } = require('node:buffer');

/** @param {string} hex */
const hex = (hex) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');

/**
 * hoost_make_fcontext from Meta's hermes-android 250829098.0.10 release AAR,
 * jni/x86_64/libhermesvm.so (0x38 bytes, as disassembled).
 */
const X86_64_UNPATCHED = hex(`
  48 89 f8  48 83 e0 f0  48 8d 40 b8  48 89 50 30  0f ae 18  d9 78 04
  48 8d 0d 10 00 00 00  48 89 48 40  48 8d 0d 08 00 00 00  48 89 48 38  c3
  55  ff e3  48 31 ff  e8 89 c2 1b 00  f4`);

/**
 * The same function hand-assembled from the PATCHED source (73f9af39b1):
 * finish goes to the R12 slot, the RBP slot is zeroed, the trampoline pushes
 * R12. (Displacements are illustrative; CI checks the real build.)
 */
const X86_64_PATCHED = hex(`
  48 89 f8  48 83 e0 f0  48 8d 40 b8  48 89 50 30  0f ae 18  d9 78 04
  48 8d 0d 18 00 00 00  48 89 48 40  48 8d 0d 0b 00 00 00  48 89 48 10
  48 c7 40 38 00 00 00 00  c3
  41 54  ff e3  48 31 ff  e8 89 c2 1b 00  f4`);

/** Meta's arm64-v8a hoost_make_fcontext (8 little-endian words). */
const ARM64_UNPATCHED = Buffer.concat(
  [
    0x927cec00, 0xd102c000, 0xf9005002, 0x10000061, 0xf9004c01, 0xd65f03c0, 0xd2800000, 0x94069831,
  ].map((w) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(w);
    return b;
  }),
);

/** …with the patch's `str xzr, [x0, #0x90]` before the `ret`. */
const ARM64_PATCHED = Buffer.concat([
  ARM64_UNPATCHED.subarray(0, 20),
  hex('1f 48 00 f9'),
  ARM64_UNPATCHED.subarray(20),
]);

const MACHINE = { x86: 3, 'armeabi-v7a': 40, x86_64: 62, 'arm64-v8a': 183 };

/**
 * @param {{
 *   abi: keyof typeof MACHINE,
 *   code: Buffer,
 *   symbol?: string,
 *   symbolSize?: number,
 *   symbolOffset?: number,
 *   buildId?: string,
 *   thumb?: boolean,
 * }} o
 */
function makeElf(o) {
  const is64 = o.abi === 'x86_64' || o.abi === 'arm64-v8a';
  const symbol = o.symbol ?? 'hoost_make_fcontext';
  const textAddr = 0x1000;

  const shstr = Buffer.from('\0.text\0.dynsym\0.dynstr\0.note.gnu.build-id\0.shstrtab\0', 'latin1');
  const nameOf = (/** @type {string} */ n) => shstr.indexOf(Buffer.from(`${n}\0`, 'latin1'));
  const dynstr = Buffer.from(`\0other\0${symbol}\0`, 'latin1');

  const symEnt = is64 ? 24 : 16;
  const dynsym = Buffer.alloc(symEnt * 3);
  /** @param {number} i @param {number} name @param {number} value @param {number} size */
  const putSym = (i, name, value, size) => {
    const b = i * symEnt;
    dynsym.writeUInt32LE(name, b);
    if (is64) {
      dynsym[b + 4] = 0x12; // GLOBAL FUNC
      dynsym.writeUInt16LE(1, b + 6);
      dynsym.writeBigUInt64LE(BigInt(value), b + 8);
      dynsym.writeBigUInt64LE(BigInt(size), b + 16);
    } else {
      dynsym.writeUInt32LE(value, b + 4);
      dynsym.writeUInt32LE(size, b + 8);
      dynsym[b + 12] = 0x12;
      dynsym.writeUInt16LE(1, b + 14);
    }
  };
  putSym(1, 1, textAddr, 0); // "other"
  putSym(2, 7, textAddr + (o.symbolOffset ?? 0) + (o.thumb ? 1 : 0), o.symbolSize ?? o.code.length);

  /** @type {Buffer} */
  let note = Buffer.alloc(0);
  if (o.buildId) {
    const desc = Buffer.from(o.buildId, 'hex');
    note = Buffer.alloc(12 + 4 + ((desc.length + 3) & ~3));
    note.writeUInt32LE(4, 0);
    note.writeUInt32LE(desc.length, 4);
    note.writeUInt32LE(3, 8);
    note.write('GNU\0', 12, 'latin1');
    desc.copy(note, 16);
  }

  const ehsize = is64 ? 64 : 52;
  const blobs = [o.code, dynsym, dynstr, note, shstr];
  /** @type {number[]} */
  const offsets = [];
  let at = ehsize;
  for (const b of blobs) {
    offsets.push(at);
    at += (b.length + 7) & ~7;
  }
  const shoff = at;
  const shentsize = is64 ? 64 : 40;
  const shnum = 6;
  const out = Buffer.alloc(shoff + shentsize * shnum);
  blobs.forEach((b, i) => b.copy(out, offsets[i] ?? 0));

  out.writeUInt32BE(0x7f454c46, 0);
  out[4] = is64 ? 2 : 1;
  out[5] = 1;
  out[6] = 1;
  out.writeUInt16LE(3, 16);
  out.writeUInt16LE(MACHINE[o.abi], 18);
  if (is64) {
    out.writeBigUInt64LE(BigInt(shoff), 0x28);
    out.writeUInt16LE(ehsize, 0x34);
    out.writeUInt16LE(shentsize, 0x3a);
    out.writeUInt16LE(shnum, 0x3c);
    out.writeUInt16LE(5, 0x3e);
  } else {
    out.writeUInt32LE(shoff, 0x20);
    out.writeUInt16LE(ehsize, 0x28);
    out.writeUInt16LE(shentsize, 0x2e);
    out.writeUInt16LE(shnum, 0x30);
    out.writeUInt16LE(5, 0x32);
  }
  /**
   * @param {number} i
   * @param {{ name: number, type: number, addr?: number, offset: number, size: number, link?: number, entsize?: number }} s
   */
  const putShdr = (i, s) => {
    const b = shoff + i * shentsize;
    out.writeUInt32LE(s.name, b);
    out.writeUInt32LE(s.type, b + 4);
    if (is64) {
      out.writeBigUInt64LE(BigInt(s.addr ?? 0), b + 0x10);
      out.writeBigUInt64LE(BigInt(s.offset), b + 0x18);
      out.writeBigUInt64LE(BigInt(s.size), b + 0x20);
      out.writeUInt32LE(s.link ?? 0, b + 0x28);
      out.writeBigUInt64LE(BigInt(s.entsize ?? 0), b + 0x38);
    } else {
      out.writeUInt32LE(s.addr ?? 0, b + 0x0c);
      out.writeUInt32LE(s.offset, b + 0x10);
      out.writeUInt32LE(s.size, b + 0x14);
      out.writeUInt32LE(s.link ?? 0, b + 0x18);
      out.writeUInt32LE(s.entsize ?? 0, b + 0x24);
    }
  };
  const [textOff = 0, symOff = 0, strOff = 0, noteOff = 0, shstrOff = 0] = offsets;
  putShdr(1, {
    name: nameOf('.text'),
    type: 1,
    addr: textAddr,
    offset: textOff,
    size: o.code.length,
  });
  putShdr(2, {
    name: nameOf('.dynsym'),
    type: 11,
    offset: symOff,
    size: dynsym.length,
    link: 3,
    entsize: symEnt,
  });
  putShdr(3, { name: nameOf('.dynstr'), type: 3, offset: strOff, size: dynstr.length });
  putShdr(4, { name: nameOf('.note.gnu.build-id'), type: 7, offset: noteOff, size: note.length });
  putShdr(5, { name: nameOf('.shstrtab'), type: 3, offset: shstrOff, size: shstr.length });
  return out;
}

module.exports = {
  ARM64_PATCHED,
  ARM64_UNPATCHED,
  X86_64_PATCHED,
  X86_64_UNPATCHED,
  hex,
  makeElf,
};
