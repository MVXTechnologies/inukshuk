import { File } from 'expo-file-system';

import {
  deletePackCell,
  packCellExists,
  packCellUri,
  readPackCell,
  writePackCell,
} from './marinePacks';
import { StorageFullError } from './storage';

jest.mock('expo-file-system', () => {
  const files = new Map<string, Uint8Array>();
  const path = (parts: (string | { uri: string })[]) =>
    parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = path(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {
      if (this.exists) throw new Error('File exists');
      files.set(this.uri, new Uint8Array());
    }
    write(bytes: Uint8Array) {
      files.set(this.uri, bytes.slice());
    }
    async bytes() {
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error('Missing file');
      return bytes.slice();
    }
    delete() {
      files.delete(this.uri);
    }
    moveSync(destination: File) {
      if (destination.exists) throw new Error('Destination exists');
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error('Missing source');
      files.set(destination.uri, bytes);
      files.delete(this.uri);
      this.uri = destination.uri;
    }
  }
  class Directory {
    uri: string;
    exists = true;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = path(parts);
    }
    create() {}
  }
  return { File, Directory, Paths: { document: 'file:///doc' }, __files: files };
});

const key = 'chs:1:2';
const oldBytes = new Uint8Array([1, 2, 3]);
const newBytes = new Uint8Array([4, 5, 6, 7]);
const files = (jest.requireMock('expo-file-system') as { __files: Map<string, Uint8Array> })
  .__files;

beforeEach(() => {
  jest.restoreAllMocks();
  files.clear();
  writePackCell(key, oldBytes);
});

it('keeps the saved cell readable when a replacement runs out of disk space', async () => {
  jest.spyOn(File.prototype, 'write').mockImplementationOnce(function () {
    throw new Error('ENOSPC');
  });
  expect(() => writePackCell(key, newBytes)).toThrow(StorageFullError);
  expect(packCellExists(key)).toBe(true);
  expect(await readPackCell(key)).toEqual(oldBytes);
  expect(files.size).toBe(1);
});

it('keeps the saved cell when staging cannot be created', async () => {
  jest.spyOn(File.prototype, 'create').mockImplementationOnce(() => {
    throw new Error('ENOSPC');
  });
  expect(() => writePackCell(key, newBytes)).toThrow(StorageFullError);
  expect(await readPackCell(key)).toEqual(oldBytes);
});

it('restores the saved cell when promotion fails', async () => {
  const move = File.prototype.moveSync;
  jest.spyOn(File.prototype, 'moveSync').mockImplementation(function (this: File, destination) {
    if (this.uri.endsWith('.tmp')) throw new Error('Move failed');
    move.call(this, destination);
  });
  expect(() => writePackCell(key, newBytes)).toThrow('Move failed');
  expect(await readPackCell(key)).toEqual(oldBytes);
  expect(files.size).toBe(1);
});

it('reads the backup if both promotion and rollback fail, then allows a retry', async () => {
  const move = File.prototype.moveSync;
  jest.spyOn(File.prototype, 'moveSync').mockImplementation(function (this: File, destination) {
    if (this.uri.endsWith('.tmp') || this.uri.endsWith('.bak')) throw new Error('Move failed');
    move.call(this, destination);
  });
  expect(() => writePackCell(key, newBytes)).toThrow('Move failed');
  expect(packCellExists(key)).toBe(true);
  expect(await readPackCell(key)).toEqual(oldBytes);
  expect(await new File(packCellUri(key)).bytes()).toEqual(oldBytes);
  jest.restoreAllMocks();
  expect(writePackCell(key, newBytes)).toBe(4);
  expect(await readPackCell(key)).toEqual(newBytes);
  expect(files.size).toBe(1);
});

it('publishes complete replacement bytes and removes temporary files', async () => {
  expect(writePackCell(key, newBytes)).toBe(4);
  expect(await readPackCell(key)).toEqual(newBytes);
  expect(files.size).toBe(1);
});

it('keeps the saved cell when it cannot be moved to backup', async () => {
  jest.spyOn(File.prototype, 'moveSync').mockImplementationOnce(() => {
    throw new Error('Permission denied');
  });
  expect(() => writePackCell(key, newBytes)).toThrow('Permission denied');
  expect(await readPackCell(key)).toEqual(oldBytes);
  expect(files.size).toBe(1);
});

it('removes recovery files when deleting a cell', async () => {
  const uri = packCellUri(key);
  files.set(`${uri}.bak`, oldBytes);
  files.set(`${uri}.tmp`, newBytes);
  deletePackCell(key);
  expect(packCellExists(key)).toBe(false);
  expect(await readPackCell(key)).toBeNull();
  expect(files.size).toBe(0);
});

it('does not publish partial bytes when the first download fails', async () => {
  files.clear();
  const write = File.prototype.write;
  jest.spyOn(File.prototype, 'write').mockImplementationOnce(function (this: File) {
    write.call(this, new Uint8Array([4]));
    throw new Error('ENOSPC');
  });
  expect(() => writePackCell(key, newBytes)).toThrow(StorageFullError);
  expect(packCellExists(key)).toBe(false);
  expect(await readPackCell(key)).toBeNull();
  expect(files.size).toBe(0);
});
