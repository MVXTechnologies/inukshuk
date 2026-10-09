// @ts-check
/**
 * Just enough ELF reading to tell which libhermesvm.so a build packaged
 * (#648): the GNU build-id, the machine (→ Android ABI), and the bytes of one
 * exported function. Little-endian ELF32/ELF64 only (every Android ABI).
 * Pure: takes a Buffer, never touches the filesystem.
 */

const { Buffer } = require('node:buffer');

const SHT_NOBITS = 8;
const SHT_NOTE = 7;
const SHT_DYNSYM = 11;
const NT_GNU_BUILD_ID = 3;

/** e_machine → Android ABI name. */
const ABI_BY_MACHINE = {
  3: 'x86',
  40: 'armeabi-v7a',
  62: 'x86_64',
  183: 'arm64-v8a',
};

/**
 * @typedef {{ name: string, type: number, addr: number, offset: number, size: number, link: number, entsize: number }} Section
 * @typedef {{ buf: Buffer, is64: boolean, machine: number, abi: string | undefined, sections: Section[] }} Elf
 */

/**
 * @param {Buffer} buf
 * @returns {Elf}
 */
function parseElf(buf) {
  if (buf.length < 52 || buf.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error('not an ELF file');
  }
  const elfClass = buf[4];
  if (elfClass !== 1 && elfClass !== 2) throw new Error(`unknown ELF class ${elfClass}`);
  if (buf[5] !== 1) throw new Error('big-endian ELF is not supported');
  const is64 = elfClass === 2;
  /** @param {number} o */
  const word = (o) => (is64 ? Number(buf.readBigUInt64LE(o)) : buf.readUInt32LE(o));

  const machine = buf.readUInt16LE(18);
  const shoff = is64 ? word(0x28) : buf.readUInt32LE(0x20);
  const shentsize = buf.readUInt16LE(is64 ? 0x3a : 0x2e);
  const shnum = buf.readUInt16LE(is64 ? 0x3c : 0x30);
  const shstrndx = buf.readUInt16LE(is64 ? 0x3e : 0x32);
  if (shoff === 0 || shnum === 0) throw new Error('ELF has no section headers');
  if (shoff + shnum * shentsize > buf.length) throw new Error('ELF section headers out of range');

  /** @type {Array<Section & { nameOffset: number }>} */
  const raw = [];
  for (let i = 0; i < shnum; i++) {
    const b = shoff + i * shentsize;
    raw.push(
      is64
        ? {
            name: '',
            nameOffset: buf.readUInt32LE(b),
            type: buf.readUInt32LE(b + 4),
            addr: word(b + 0x10),
            offset: word(b + 0x18),
            size: word(b + 0x20),
            link: buf.readUInt32LE(b + 0x28),
            entsize: word(b + 0x38),
          }
        : {
            name: '',
            nameOffset: buf.readUInt32LE(b),
            type: buf.readUInt32LE(b + 4),
            addr: buf.readUInt32LE(b + 0x0c),
            offset: buf.readUInt32LE(b + 0x10),
            size: buf.readUInt32LE(b + 0x14),
            link: buf.readUInt32LE(b + 0x18),
            entsize: buf.readUInt32LE(b + 0x24),
          },
    );
  }
  const shstr = raw[shstrndx];
  const sections = raw.map(({ nameOffset, ...s }) => ({
    ...s,
    name: shstr ? cString(buf, shstr.offset + nameOffset) : '',
  }));
  return { buf, is64, machine, abi: ABI_BY_MACHINE[/** @type {3} */ (machine)], sections };
}

/**
 * @param {Buffer} buf
 * @param {number} start
 */
function cString(buf, start) {
  const end = buf.indexOf(0, start);
  return buf.toString('latin1', start, end === -1 ? buf.length : end);
}

/**
 * @param {Elf} elf
 * @param {Section} s
 */
function sectionBytes(elf, s) {
  if (s.type === SHT_NOBITS) return Buffer.alloc(0);
  if (s.offset + s.size > elf.buf.length) throw new Error(`section ${s.name} out of range`);
  return elf.buf.subarray(s.offset, s.offset + s.size);
}

/**
 * The GNU build-id (hex), which `strip` keeps: it identifies the link that
 * produced the library, so a stripped, packaged copy still names its build.
 * @param {Elf} elf
 * @returns {string | undefined}
 */
function buildId(elf) {
  for (const s of elf.sections) {
    if (s.type !== SHT_NOTE) continue;
    const notes = sectionBytes(elf, s);
    let o = 0;
    while (o + 12 <= notes.length) {
      const namesz = notes.readUInt32LE(o);
      const descsz = notes.readUInt32LE(o + 4);
      const type = notes.readUInt32LE(o + 8);
      const nameStart = o + 12;
      const descStart = nameStart + align4(namesz);
      if (descStart + descsz > notes.length) break;
      const name = notes.toString('latin1', nameStart, nameStart + Math.max(0, namesz - 1));
      if (type === NT_GNU_BUILD_ID && name === 'GNU') {
        return notes.subarray(descStart, descStart + descsz).toString('hex');
      }
      o = descStart + align4(descsz);
    }
  }
  return undefined;
}

/** @param {number} n */
const align4 = (n) => (n + 3) & ~3;

/**
 * The bytes of an exported (.dynsym) function, or undefined when the library
 * does not export it. A zero-sized symbol (hand-written assembly without a
 * .size directive) yields `fallbackSize` bytes.
 * @param {Elf} elf
 * @param {string} name
 * @param {number} [fallbackSize]
 * @returns {Buffer | undefined}
 */
function exportedSymbolBytes(elf, name, fallbackSize = 0x80) {
  const dynsym = elf.sections.find((s) => s.type === SHT_DYNSYM);
  if (!dynsym) return undefined;
  const strtab = elf.sections[dynsym.link];
  if (!strtab) return undefined;
  const syms = sectionBytes(elf, dynsym);
  const strs = sectionBytes(elf, strtab);
  const entsize = dynsym.entsize || (elf.is64 ? 24 : 16);
  for (let o = 0; o + entsize <= syms.length; o += entsize) {
    const nameOff = syms.readUInt32LE(o);
    if (cString(strs, nameOff) !== name) continue;
    // Thumb functions carry the mode in bit 0 of the address.
    const value = (elf.is64 ? Number(syms.readBigUInt64LE(o + 8)) : syms.readUInt32LE(o + 4)) & ~1;
    const size = elf.is64 ? Number(syms.readBigUInt64LE(o + 16)) : syms.readUInt32LE(o + 8);
    const sec = elf.sections.find(
      (s) => s.type !== SHT_NOBITS && s.addr !== 0 && value >= s.addr && value < s.addr + s.size,
    );
    if (!sec) return undefined;
    const start = sec.offset + (value - sec.addr);
    const end = Math.min(start + (size || fallbackSize), sec.offset + sec.size);
    return elf.buf.subarray(start, end);
  }
  return undefined;
}

module.exports = { ABI_BY_MACHINE, buildId, exportedSymbolBytes, parseElf };
