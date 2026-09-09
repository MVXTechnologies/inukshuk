import {
  LOG_TAIL_CHARS,
  LOG_TAIL_LINES,
  describeServerStartFailure,
  logTail,
} from './serverStartFailure';

describe('logTail', () => {
  it('returns null for an empty or missing log', () => {
    expect(logTail(null)).toBeNull();
    expect(logTail(undefined)).toBeNull();
    expect(logTail('')).toBeNull();
    expect(logTail('\n\n  \n')).toBeNull();
  });

  it('keeps the last lines, dropping blanks and surrounding whitespace', () => {
    const lines = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, i) => `  line ${i}  `);
    const tail = logTail(lines.join('\n\n'));
    expect(tail?.split('\n')).toHaveLength(LOG_TAIL_LINES);
    expect(tail?.startsWith('line 5')).toBe(true);
    expect(tail?.endsWith(`line ${LOG_TAIL_LINES + 4}`)).toBe(true);
  });

  it('caps the excerpt by characters, keeping the end', () => {
    const long = 'x'.repeat(LOG_TAIL_CHARS + 50) + 'END';
    const tail = logTail(long);
    expect(tail).toHaveLength(LOG_TAIL_CHARS);
    expect(tail?.endsWith('END')).toBe(true);
  });
});

describe('describeServerStartFailure', () => {
  it('names the attempts, the library error and the log excerpt', () => {
    const msg = describeServerStartFailure(
      new Error('Server #58669.0 crashed: Native server exited with status -1'),
      '2026-09-08 22:57:12: (configfile.c.1234) unknown config-key: url.access-deny',
      2,
    );
    expect(msg).toContain('after 2 attempts');
    expect(msg).toContain('exited with status -1');
    expect(msg).toContain('lighttpd error log:');
    expect(msg).toContain('unknown config-key');
  });

  it('says so when there is no log, and copes with non-Error rejections', () => {
    expect(describeServerStartFailure('boom', null, 1)).toBe(
      'Loopback server failed to start after 1 attempt: boom (no lighttpd error log)',
    );
    expect(describeServerStartFailure(undefined, null, 1)).toContain('unknown error');
  });
});
