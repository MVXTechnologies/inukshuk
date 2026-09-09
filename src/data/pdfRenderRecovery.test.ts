const mockFiles = new Map<string, string>();
let mockDocument = 'file:///container-A/Documents';
let mockFailMove = false;

jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    get size() {
      return mockFiles.get(this.uri)?.length ?? 0;
    }
    create() {
      mockFiles.set(this.uri, '');
    }
    write(text: string) {
      mockFiles.set(this.uri, text);
    }
    textSync() {
      if (!this.exists) throw new Error('missing');
      return mockFiles.get(this.uri)!;
    }
    delete() {
      mockFiles.delete(this.uri);
    }
    moveSync(target: File) {
      if (mockFailMove) throw new Error('move failed');
      if (target.exists) throw new Error('destination exists');
      mockFiles.set(target.uri, this.textSync());
      mockFiles.delete(this.uri);
      this.uri = target.uri;
    }
  }
  return {
    File,
    Paths: {
      get document() {
        return { uri: mockDocument };
      },
    },
  };
});

function load(): typeof import('./pdfRenderRecovery') {
  let module!: typeof import('./pdfRenderRecovery');
  jest.isolateModules(() => {
    module = jest.requireActual<typeof import('./pdfRenderRecovery')>('./pdfRenderRecovery');
  });
  return module;
}
const input = { fileUri: 'file:///container-A/Documents/maps/eco.pdf', pageIndex: 2 };
beforeEach(() => {
  mockFiles.clear();
  mockDocument = 'file:///container-A/Documents';
  mockFailMove = false;
});

test('cold module reload recovers the durable checkpoint without modifying the PDF', () => {
  mockFiles.set(input.fileUri, 'original PDF bytes');
  const token = load().beginPdfRender(input);
  expect(load().readInterruptedPdfRender()).toEqual({ ...input, token });
  expect(mockFiles.get(input.fileUri)).toBe('original PDF bytes');
  expect([...mockFiles.keys()].filter((key) => key !== input.fileUri)).toHaveLength(1);
});
test('successful matching finish leaves no interrupted render or staging file', () => {
  const api = load();
  api.finishPdfRender(api.beginPdfRender(input));
  expect(load().readInterruptedPdfRender()).toBeNull();
  expect(mockFiles.size).toBe(0);
});
test('an unpersisted recovery pause protects its checkpoint from later renders and completions', () => {
  const api = load();
  const token = api.beginPdfRender(input);
  api.protectInterruptedPdfRender(token);
  const before = [...mockFiles.entries()];
  expect(() => api.beginPdfRender({ ...input, pageIndex: 3 })).toThrow(
    'Could not save map recovery. Free storage and restart the app.',
  );
  api.finishPdfRender(token);
  api.clearInterruptedPdfRender('old-token');
  expect([...mockFiles.entries()]).toEqual(before);
  expect(api.readInterruptedPdfRender()).toEqual({ ...input, token });
  api.clearInterruptedPdfRender(token);
  expect(api.readInterruptedPdfRender()).toBeNull();
  expect(() => api.beginPdfRender(input)).not.toThrow();
});

test('a fresh process can acknowledge a protected checkpoint after saving the pause', () => {
  const api = load();
  const token = api.beginPdfRender(input);
  api.protectInterruptedPdfRender(token);
  const restarted = load();
  expect(restarted.readInterruptedPdfRender()).toEqual({ ...input, token });
  restarted.clearInterruptedPdfRender(token);
  expect(() => restarted.beginPdfRender(input)).not.toThrow();
});
test('an old completion or acknowledgement never clears the newer render', () => {
  const api = load();
  const old = api.beginPdfRender(input);
  const newer = api.beginPdfRender({ ...input, pageIndex: 3 });
  expect(old).not.toBe(newer);
  api.finishPdfRender(old);
  api.clearInterruptedPdfRender(old);
  expect(load().readInterruptedPdfRender()).toEqual({ ...input, pageIndex: 3, token: newer });
  api.clearInterruptedPdfRender(newer);
  expect(load().readInterruptedPdfRender()).toBeNull();
});
test('container rotation rebases persisted document-relative PDF paths', () => {
  const token = load().beginPdfRender(input);
  expect([...mockFiles.values()].join('')).not.toContain('container-A');
  const previous = [...mockFiles.entries()];
  mockFiles.clear();
  for (const [key, value] of previous)
    mockFiles.set(key.replace('container-A', 'container-B'), value);
  mockDocument = 'file:///container-B/Documents';
  expect(load().readInterruptedPdfRender()).toEqual({
    token,
    pageIndex: 2,
    fileUri: 'file:///container-B/Documents/maps/eco.pdf',
  });
});
test.each([
  '{',
  'null',
  '{}',
  '{"token":3}',
  '{"version":1,"token":"x","filePath":"../outside.pdf","pageIndex":0}',
  'x'.repeat(8193),
])('invalid checkpoint is ignored safely (%s)', (text) => {
  load().beginPdfRender(input);
  const key = [...mockFiles.keys()][0]!;
  mockFiles.set(key, text);
  expect(load().readInterruptedPdfRender()).toBeNull();
});
test('failed promotion throws before dispatch and keeps a recoverable stage', () => {
  const api = load();
  api.beginPdfRender(input);
  mockFailMove = true;
  expect(() => api.beginPdfRender({ ...input, pageIndex: 4 })).toThrow('move failed');
  expect(load().readInterruptedPdfRender()?.pageIndex).toBe(4);
  mockFailMove = false;
  api.beginPdfRender(input);
  expect(mockFiles.size).toBe(1);
});
test.each([-1, 0.5, NaN, Infinity])('invalid page index %s never writes anything', (pageIndex) => {
  expect(() => load().beginPdfRender({ ...input, pageIndex })).toThrow();
  expect(mockFiles.size).toBe(0);
});
