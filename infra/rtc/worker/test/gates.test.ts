/**
 * Relay CI gates (gates.mjs, security review §6.3): they pass on this tree
 * and catch each violation they exist for.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKER = join(__dirname, '..');
const GATES = join(WORKER, 'gates.mjs');

function run(dir: string): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync('node', [GATES, dir], { encoding: 'utf8', stdio: 'pipe' }),
    };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr) };
  }
}

describe('gates.mjs', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rtc-gates-'));
    cpSync(join(WORKER, 'src'), join(tmp, 'src'), { recursive: true });
    cpSync(join(WORKER, 'wrangler.toml'), join(tmp, 'wrangler.toml'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const toml = () => readFileSync(join(tmp, 'wrangler.toml'), 'utf8');
  const setToml = (s: string) => writeFileSync(join(tmp, 'wrangler.toml'), s);

  it('passes on the committed Worker', () => {
    expect(run(WORKER)).toEqual({ ok: true, out: 'rtc gates: ok\n' });
    expect(run(tmp).ok).toBe(true);
  });

  it.each([
    ['console.log(roomId);', 'a console call'],
    ['await this.state.storage.get("x");', 'storage access'],
    ['await bucket.put(key, value);', 'a .put( write'],
    ['ctx.sql.exec("select 1");', 'SQL access'],
    ['let kv: KVNamespace;', 'a storage binding type'],
  ])('fails on %s', (line, what) => {
    writeFileSync(join(tmp, 'src', 'bad.ts'), `export {};\n${line}\n`);
    const r = run(tmp);
    expect(r.ok).toBe(false);
    expect(r.out).toContain(`src/bad.ts:2: ${what}`);
  });

  it('ignores test files', () => {
    writeFileSync(join(tmp, 'src', 'x.test.ts'), 'console.log(1);\n');
    expect(run(tmp).ok).toBe(true);
  });

  it.each([
    [
      (s: string) =>
        s.replace('[observability]\nenabled = false', '[observability]\nenabled = true'),
      'enabled must be false',
    ],
    [
      (s: string) => s.replace('invocation_logs = false', 'invocation_logs = true'),
      'invocation_logs must be false',
    ],
    [(s: string) => s + '\n[[kv_namespaces]]\nbinding = "KV"\n', '[[kv_namespaces]]'],
    [(s: string) => s + '\n[[r2_buckets]]\nbinding = "B"\n', '[[r2_buckets]]'],
    [(s: string) => s + '\n[[d1_databases]]\nbinding = "D"\n', '[[d1_databases]]'],
    [(s: string) => s.replace('new_sqlite_classes = ', 'new_classes = '), 'new_sqlite_classes'],
    [(s: string) => s.replace('name = "TURN_LIMITER"', 'name = "OTHER"'), 'TURN_LIMITER missing'],
    [(s: string) => s.replace('name = "inukshuk-rtc"', 'name = "inukshuk-tiles"'), 'R-OPS-1'],
    [(s: string) => s.replace('[vars]', '[vars]\nTURN_KEY_API_TOKEN = "x"'), 'is a secret'],
    [(s: string) => s.replace('TURN_ENABLED = "1"', ''), 'kill switches'],
  ])('fails on a weakened wrangler.toml (%#)', (edit, message) => {
    const before = toml();
    const after = edit(before);
    expect(after).not.toBe(before);
    setToml(after);
    const r = run(tmp);
    expect(r.ok).toBe(false);
    expect(r.out).toContain(message);
  });
});

describe('wrangler.toml (R-META-2, R-RL-1, R-TURN-2…4)', () => {
  const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
  const value = (k: string) => new RegExp(`^${k} = "([^"]*)"`, 'm').exec(toml)?.[1];

  it('documents limits that match the review', () => {
    expect(value('TURN_TTL_S')).toBe('900');
    expect(value('TURN_PER_SOCKET_PER_HOUR')).toBe('6');
    expect(value('TURN_PER_IP_PER_HOUR')).toBe('20');
    expect(value('TURN_USAGE_OFF_PERCENT')).toBe('80');
    expect(value('ROOM_MAX_SOCKETS')).toBe('128');
    expect(value('ROOM_MAX_PER_IP')).toBe('16');
    expect(toml).toMatch(
      /name = "WS_LIMITER"\s+namespace_id = "\d+"\s+\[ratelimits\.simple\]\s+limit = 120\s+period = 60/,
    );
    expect(toml).toMatch(/crons = \["\*\/10 \* \* \* \*"\]/);
  });
});
