/**
 * "I already donated" (#476, round 3): the app side of the email check.
 *
 * Honour system. Nothing is checked against any donation; the code only shows
 * the person reads the inbox. A success hides the tip button for
 * {@link TIP_JAR_REST_MS}, exactly like a tip made in the app.
 *
 * The Worker answers a wrong, expired or never-requested code the same way
 * (no enumeration), so telling "expired" apart is done here, from when the
 * app itself asked for the code.
 *
 * Pure: no React Native / Expo imports.
 */

/** Codes live 15 minutes on the Worker. */
export const VERIFY_CODE_TTL_MS = 15 * 60_000;

/** How long the tip button rests after a tip or a verified "I already donated". */
export const TIP_JAR_REST_MS = 365 * 24 * 60 * 60 * 1000;

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/.test(email) ? email : null;
}

export function normalizeCode(value: string): string | null {
  const code = value.replace(/\s+/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}

/** What `POST /donor-verify/check` said, as the data layer reports it. */
export type CheckResult = 'ok' | 'rejected' | 'rate-limited' | 'offline';

export type VerifyOutcome = 'verified' | 'wrong' | 'expired' | 'rate-limited' | 'offline';

export function checkOutcome(result: CheckResult, sentAt: number, now: number): VerifyOutcome {
  switch (result) {
    case 'ok':
      return 'verified';
    case 'rejected':
      return now - sentAt >= VERIFY_CODE_TTL_MS ? 'expired' : 'wrong';
    case 'rate-limited':
      return 'rate-limited';
    case 'offline':
      return 'offline';
  }
}

export function verifyMessage(outcome: Exclude<VerifyOutcome, 'verified'>): string {
  switch (outcome) {
    case 'wrong':
      return 'That code does not match. Check the email and try again.';
    case 'expired':
      return 'That code has expired. Ask for a new one.';
    case 'rate-limited':
      return 'Too many tries for now. Please wait a little and try again.';
    case 'offline':
      return "Couldn't reach our server. Check your connection and try again.";
  }
}

/** When the tip button may come back after resting from `now`. */
export function restUntil(now: number): number {
  return now + TIP_JAR_REST_MS;
}
