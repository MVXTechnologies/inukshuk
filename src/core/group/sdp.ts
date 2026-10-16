/**
 * DTLS fingerprint binding for WebRTC links (security review R-RTC-2).
 *
 * The SDP offer and answer travel inside an authenticated SyncSession
 * (R-RTC-1), so the `a=fingerprint` they carry is the certificate the peer
 * vouched for. Once DTLS connects, the certificate the transport actually
 * negotiated is read back from `RTCPeerConnection.getStats()`:
 *
 *   transport.remoteCertificateId → certificate.fingerprint (+ fingerprintAlgorithm)
 *
 * and the link is closed unless the two agree. libwebrtc already checks the
 * DTLS certificate against the remote description it was given; this is the
 * app-level check that the description it was given is the authenticated one.
 *
 * Pure: no React Native, no WebRTC types. The ICE candidate filter (no
 * `host` candidates on the internet path, R-RTC-3) lives here too.
 */

/** A certificate fingerprint: lower-case hash name, upper-case colon-separated hex. */
export interface CertFingerprint {
  readonly algorithm: string;
  readonly value: string;
}

/** Digest lengths (bytes) of the hashes accepted for the binding. SHA-1 and MD5 are refused. */
const DIGEST_BYTES: Readonly<Record<string, number>> = {
  'sha-256': 32,
  'sha-384': 48,
  'sha-512': 64,
};

/**
 * Normalises a fingerprint (`sha-256` + `ab:cd:…`) or returns null when the
 * algorithm is not accepted or the value is not exactly one digest of it.
 */
export function normalizeFingerprint(algorithm: string, value: string): CertFingerprint | null {
  const alg = algorithm.trim().toLowerCase();
  const bytes = DIGEST_BYTES[alg];
  if (bytes === undefined) return null;
  const hex = value.trim().toUpperCase();
  const parts = hex.split(':');
  if (parts.length !== bytes) return null;
  if (!parts.every((p) => /^[0-9A-F]{2}$/.test(p))) return null;
  return { algorithm: alg, value: hex };
}

/**
 * Every `a=fingerprint:` line of an SDP (session and media level), normalised,
 * in order, without duplicates. Lines with a refused algorithm or a malformed
 * value are dropped; `sdpFingerprintBinding` then fails closed if none remain.
 */
export function parseSdpFingerprints(sdp: string): CertFingerprint[] {
  const out: CertFingerprint[] = [];
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.toLowerCase().startsWith('a=fingerprint:')) continue;
    const rest = line.slice('a=fingerprint:'.length).trim();
    const space = rest.search(/\s/);
    if (space <= 0) continue;
    const fp = normalizeFingerprint(rest.slice(0, space), rest.slice(space + 1));
    if (fp && !out.some((o) => sameFingerprint(o, fp))) out.push(fp);
  }
  return out;
}

export function sameFingerprint(a: CertFingerprint, b: CertFingerprint): boolean {
  return a.algorithm === b.algorithm && a.value === b.value;
}

/** One entry of a `getStats()` report: `{ id, type, …members }`. */
export type StatsEntry = Readonly<Record<string, unknown>>;

/** What `RTCPeerConnection.getStats()` resolves to (a Map keyed by stats id). */
export type StatsReport = ReadonlyMap<string, StatsEntry>;

function str(entry: StatsEntry | undefined, key: string): string | undefined {
  const v = entry?.[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * The certificate fingerprint the DTLS transport negotiated, read from a
 * stats report. `side` picks `remoteCertificateId` (the peer's certificate)
 * or `localCertificateId` (ours).
 *
 * Only transports whose `dtlsState` is `connected` count. With BUNDLE there is
 * one; if several are connected they must all carry the same certificate, or
 * the result is null (fail closed), as it is when nothing is connected yet.
 */
export function transportCertificateFingerprint(
  stats: StatsReport,
  side: 'remote' | 'local',
): CertFingerprint | null {
  const idKey = side === 'remote' ? 'remoteCertificateId' : 'localCertificateId';
  let found: CertFingerprint | null = null;
  for (const entry of stats.values()) {
    if (str(entry, 'type') !== 'transport') continue;
    if (str(entry, 'dtlsState') !== 'connected') continue;
    const certId = str(entry, idKey);
    if (certId === undefined) return null;
    const cert = stats.get(certId);
    if (str(cert, 'type') !== 'certificate') return null;
    const alg = str(cert, 'fingerprintAlgorithm');
    const value = str(cert, 'fingerprint');
    if (alg === undefined || value === undefined) return null;
    const fp = normalizeFingerprint(alg, value);
    if (!fp) return null;
    if (found && !sameFingerprint(found, fp)) return null;
    found = fp;
  }
  return found;
}

export type FingerprintBinding =
  | { readonly ok: true; readonly fingerprint: CertFingerprint }
  | {
      readonly ok: false;
      readonly reason: 'no-sdp-fingerprint' | 'not-connected' | 'mismatch';
    };

/**
 * R-RTC-2: does the certificate the DTLS transport negotiated with the peer
 * equal the one in the peer's authenticated SDP?
 *
 * Every SDP fingerprint of the negotiated algorithm must equal the transport's
 * (with BUNDLE they are all the same certificate); one stray line is a
 * mismatch, not an alternative. Close the link on anything but `ok`.
 */
export function sdpFingerprintBinding(remoteSdp: string, stats: StatsReport): FingerprintBinding {
  const claimed = parseSdpFingerprints(remoteSdp);
  if (claimed.length === 0) return { ok: false, reason: 'no-sdp-fingerprint' };
  const actual = transportCertificateFingerprint(stats, 'remote');
  if (!actual) return { ok: false, reason: 'not-connected' };
  const sameAlg = claimed.filter((c) => c.algorithm === actual.algorithm);
  if (sameAlg.length === 0 || !sameAlg.every((c) => sameFingerprint(c, actual))) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, fingerprint: actual };
}

// ── ICE candidate filter (R-RTC-3) ──────────────────────────────────────────

/** What an internet path may reveal: `direct` = public (srflx) or relay; `relay` = TURN only. */
export type IcePolicy = 'direct' | 'relay';

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

const CANDIDATE_TYPES: ReadonlySet<string> = new Set(['host', 'srflx', 'prflx', 'relay']);

/**
 * The `typ` of an ICE candidate (`candidate:…` or `a=candidate:…`), or null
 * when it is not a well-formed candidate line (fail closed).
 */
export function candidateType(candidate: string): CandidateType | null {
  const line = candidate.trim().replace(/^a=/, '');
  if (!line.startsWith('candidate:')) return null;
  const parts = line.slice('candidate:'.length).split(/\s+/);
  // foundation component transport priority address port "typ" type …
  if (parts.length < 8 || parts[6] !== 'typ') return null;
  const typ = parts[7]!;
  return CANDIDATE_TYPES.has(typ) ? (typ as CandidateType) : null;
}

/**
 * Whether a candidate may be sent or used on an internet path. Never a `host`
 * candidate (a private LAN address: the mesh covers same-LAN peers), never an
 * unparseable one; `relay` policy keeps TURN candidates only (R-RTC-6). The
 * empty candidate (end of candidates) always passes.
 */
export function allowCandidate(candidate: string, policy: IcePolicy): boolean {
  if (candidate.trim() === '') return true;
  const typ = candidateType(candidate);
  if (typ === null || typ === 'host') return false;
  return policy === 'relay' ? typ === 'relay' : true;
}

/** An SDP with every `a=candidate` line {@link allowCandidate} refuses removed. */
export function filterSdpCandidates(sdp: string, policy: IcePolicy): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('a=candidate:') || allowCandidate(line, policy))
    .join(eol);
}

/**
 * Which internet path a connected peer connection actually uses, from its
 * stats: the selected candidate pair (the transport's `selectedCandidatePairId`,
 * else a nominated, succeeded pair) is `relay` when either end is a TURN
 * candidate, `direct` otherwise. Null when no pair is selected yet.
 */
export function selectedPathKind(stats: StatsReport): 'direct' | 'relay' | null {
  let pair: StatsEntry | undefined;
  for (const entry of stats.values()) {
    if (str(entry, 'type') !== 'transport') continue;
    const id = str(entry, 'selectedCandidatePairId');
    if (id !== undefined) pair = stats.get(id);
  }
  if (pair === undefined) {
    for (const entry of stats.values()) {
      if (
        str(entry, 'type') === 'candidate-pair' &&
        entry['nominated'] === true &&
        str(entry, 'state') === 'succeeded'
      ) {
        pair = entry;
        break;
      }
    }
  }
  if (pair === undefined || str(pair, 'type') !== 'candidate-pair') return null;
  const types = ['localCandidateId', 'remoteCandidateId'].map((k) => {
    const id = str(pair, k);
    return id === undefined ? undefined : str(stats.get(id), 'candidateType');
  });
  if (types.some((t) => t === undefined)) return null;
  return types.includes('relay') ? 'relay' : 'direct';
}
