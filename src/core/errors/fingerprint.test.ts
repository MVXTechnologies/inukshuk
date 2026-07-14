import {
  errorMarker,
  fingerprintError,
  fnv1a32,
  normalizeMessage,
  normalizeStackFrames,
} from './fingerprint';

describe('normalizeMessage', () => {
  it('replaces numbers with a placeholder', () => {
    expect(normalizeMessage('timeout after 3000ms (attempt 2)')).toBe(
      'timeout after #ms (attempt #)',
    );
  });

  it('replaces URIs, hex ids and quoted strings', () => {
    expect(normalizeMessage("cannot read file file:///data/user/0/x/y.gpx: 'oops'")).toBe(
      'cannot read file <uri> <str>',
    );
    expect(normalizeMessage('object 0xdeadbeef and id ab12cd34ef56 missing')).toBe(
      'object <hex> and id <hex> missing',
    );
  });

  it('collapses whitespace and truncates to 200 chars', () => {
    expect(normalizeMessage('a   b\n\tc')).toBe('a b c');
    expect(normalizeMessage('x'.repeat(500))).toHaveLength(200);
  });
});

describe('normalizeStackFrames', () => {
  it('parses V8-style frames and keeps only function names', () => {
    const stack = [
      'TypeError: boom',
      '    at parseGpx (http://localhost:8081/index.bundle:1234:56)',
      '    at importTrack (http://localhost:8081/index.bundle:2345:67)',
      '    at http://localhost:8081/index.bundle:99:1',
    ].join('\n');
    expect(normalizeStackFrames(stack)).toEqual(['parseGpx', 'importTrack', '<anonymous>']);
  });

  it('parses Hermes release frames (address at bundle offsets)', () => {
    const stack = [
      'Error: boom',
      '    at reduceStatsWith (address at index.android.bundle:1:456789)',
      '    at anonymous (address at index.android.bundle:1:999999)',
    ].join('\n');
    expect(normalizeStackFrames(stack)).toEqual(['reduceStatsWith', 'anonymous']);
  });

  it('parses JSC-style fn@file:line:col frames, including anonymous ones', () => {
    const stack = ['boom', 'onPress@app.bundle:10:20', '@app.bundle:30:40'].join('\n');
    expect(normalizeStackFrames(stack)).toEqual(['onPress', '<anonymous>']);
  });

  it('caps the number of frames', () => {
    const stack = Array.from({ length: 10 }, (_, i) => `    at fn${i} (b:1:${i})`).join('\n');
    expect(normalizeStackFrames(stack, 3)).toEqual(['fn0', 'fn1', 'fn2']);
  });
});

describe('fnv1a32', () => {
  it('is stable and 8 hex chars', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
    expect(fnv1a32('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32('hello')).not.toBe(fnv1a32('hellp'));
  });
});

describe('fingerprintError', () => {
  const stackA = [
    'TypeError: cannot read x of undefined',
    '    at parseGpx (address at index.android.bundle:1:1111)',
    '    at importTrack (address at index.android.bundle:1:2222)',
  ].join('\n');
  // Same bug, next build: identical frames at different bundle offsets.
  const stackB = [
    'TypeError: cannot read x of undefined',
    '    at parseGpx (address at index.android.bundle:1:70707)',
    '    at importTrack (address at index.android.bundle:1:80808)',
  ].join('\n');

  it('matches across builds when only locations changed', () => {
    expect(fingerprintError('cannot read x of undefined', stackA)).toBe(
      fingerprintError('cannot read x of undefined', stackB),
    );
  });

  it('differs when the failing frames differ', () => {
    const other = stackA.replace('parseGpx', 'parsePdf');
    expect(fingerprintError('cannot read x of undefined', stackA)).not.toBe(
      fingerprintError('cannot read x of undefined', other),
    );
  });

  it('matches when only volatile message fragments differ', () => {
    expect(fingerprintError('timeout after 3000ms', stackA)).toBe(
      fingerprintError('timeout after 5000ms', stackA),
    );
  });

  it('works without a stack', () => {
    expect(fingerprintError('boom')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('errorMarker', () => {
  it('formats the searchable marker', () => {
    expect(errorMarker('12ab34cd')).toBe('[auto-report:12ab34cd]');
  });
});
