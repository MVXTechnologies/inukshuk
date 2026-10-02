/**
 * "I already donated" (#476, round 3): an honour system with an email check.
 * Nobody is checked against any donation record — the email only proves the
 * person reads that inbox, which is enough friction to keep the tip button
 * away for a year on a device of someone who says they gave elsewhere.
 *
 *   POST /donor-verify/start {email}          → 202 {ok: true}   (always, once valid)
 *   POST /donor-verify/check {email, code}    → 200 {ok: true} | 400 {ok: false}
 *   429 when rate-limited; 400 on malformed input; 404 when not configured.
 *
 * Storage (R2, the Worker's only store): ONE object per pending email at
 * `donor-verify/<hmac(salt, email)>.json` holding
 * `{ proof: hmac(salt, email|code), expiresAt, attempts, starts: [ms…] }`.
 * The email itself and the code are never stored; the object is deleted on a
 * successful check, after too many wrong tries, and swept once expired (plus
 * an R2 lifecycle rule as a backstop, see docs/DEPLOYMENT.md).
 *
 * Responses are generic: `start` answers the same for any valid address, and
 * `check` says only ok / not ok (wrong, expired and "never requested" look
 * alike), so neither endpoint tells anyone whether an address was used.
 */

export const CODE_TTL_MS = 15 * 60_000;
/** Codes sent per email per hour. */
export const MAX_STARTS_PER_HOUR = 3;
/** Wrong guesses allowed per code before it is burned. */
export const MAX_ATTEMPTS = 5;
export const PREFIX = 'donor-verify/';
const HOUR_MS = 60 * 60_000;
const MAX_BODY_BYTES = 1024;

export interface PendingCode {
  proof: string;
  expiresAt: number;
  attempts: number;
  starts: number[];
}

export interface VerifyDeps {
  get(key: string): Promise<PendingCode | null>;
  put(key: string, value: PendingCode): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete expired objects under PREFIX (best effort, bounded). */
  sweep(now: number): Promise<void>;
  /** Per-client rate limit (IP and route); true = allowed. */
  allow(clientKey: string): Promise<boolean>;
  /** HMAC-SHA256(salt, message) as hex. */
  hmac(message: string): Promise<string>;
  /** Six random digits. */
  code(): string;
  sendCode(email: string, code: string): Promise<boolean>;
  now(): number;
}

export interface VerifyRequest {
  route: 'start' | 'check';
  method: string;
  client: string;
  body: string;
}

export interface VerifyResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Lower-case, trimmed; null when it does not look like one address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/.test(email) ? email : null;
}

export function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.replace(/\s+/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}

/** Constant-time comparison of two strings (length leaks, content does not). */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const bad = (error: string): VerifyResponse => ({ status: 400, body: { ok: false, error } });
const limited: VerifyResponse = { status: 429, body: { ok: false, error: 'try again later' } };

export async function handleVerify(req: VerifyRequest, deps: VerifyDeps): Promise<VerifyResponse> {
  if (req.method !== 'POST')
    return { status: 405, body: { ok: false, error: 'method not allowed' } };
  if (new TextEncoder().encode(req.body).length > MAX_BODY_BYTES) return bad('body too large');
  if (!(await deps.allow(`${req.route}:${req.client}`))) return limited;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(req.body);
    if (typeof parsed !== 'object' || parsed === null) return bad('invalid body');
    raw = parsed as Record<string, unknown>;
  } catch {
    return bad('invalid JSON');
  }
  const email = normalizeEmail(raw.email);
  if (email === null) return bad('invalid email');
  const now = deps.now();
  const key = `${PREFIX}${await deps.hmac(`email:${email}`)}.json`;
  const pending = await deps.get(key);

  if (req.route === 'start') {
    const starts = (pending?.starts ?? []).filter((t) => now - t < HOUR_MS);
    if (starts.length >= MAX_STARTS_PER_HOUR) return limited;
    const code = deps.code();
    await deps.put(key, {
      proof: await deps.hmac(`code:${email}|${code}`),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      starts: [...starts, now],
    });
    // A failed send is not reported to the caller (it would say something
    // about the address); the person simply asks again.
    await deps.sendCode(email, code).catch(() => false);
    await deps.sweep(now).catch(() => undefined);
    return { status: 202, body: { ok: true } };
  }

  const code = normalizeCode(raw.code);
  if (code === null) return bad('invalid code');
  const nope: VerifyResponse = { status: 400, body: { ok: false } };
  if (pending === null || pending.proof === '' || now >= pending.expiresAt) return nope;
  const proof = await deps.hmac(`code:${email}|${code}`);
  if (sameString(proof, pending.proof)) {
    await deps.delete(key);
    return { status: 200, body: { ok: true } };
  }
  const attempts = pending.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    // Burn the code but keep the hourly start count, so the limit holds.
    await deps.put(key, { ...pending, proof: '', attempts, expiresAt: now });
  } else {
    await deps.put(key, { ...pending, attempts });
  }
  return nope;
}

/** Six uniformly random digits from a CSPRNG (rejection sampling, no modulo bias). */
export function randomCode(getRandomValues: (a: Uint32Array) => Uint32Array): string {
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    getRandomValues(buf);
    const n = buf[0] ?? 0;
    if (n < limit) return String(n % 1_000_000).padStart(6, '0');
  }
}

/** The bilingual plain-text message. */
export function codeEmail(code: string): { subject: string; text: string } {
  return {
    subject: 'Your Inukshuk code / Votre code Inukshuk',
    text: [
      `Your Inukshuk code is ${code}. It expires in 15 minutes.`,
      'If you did not ask for it, you can ignore this email.',
      '',
      `Votre code Inukshuk est ${code}. Il expire dans 15 minutes.`,
      'Si vous ne l’avez pas demandé, vous pouvez ignorer ce courriel.',
      '',
      '— Inukshuk (MVX Technologies). Your address is not stored. / Votre adresse n’est pas conservée.',
    ].join('\n'),
  };
}
