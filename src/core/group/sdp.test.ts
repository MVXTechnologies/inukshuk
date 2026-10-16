import {
  normalizeFingerprint,
  parseSdpFingerprints,
  sdpFingerprintBinding,
  transportCertificateFingerprint,
  type StatsEntry,
  type StatsReport,
} from './sdp';

const FP_A =
  '6B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08';
const FP_B =
  'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90';

/** A data-channel-only offer as libwebrtc writes it (BUNDLE, one m=application line). */
function sdpWith(...fingerprintLines: string[]): string {
  return [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=ice-options:trickle',
    ...fingerprintLines,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}

function report(entries: StatsEntry[]): StatsReport {
  return new Map(entries.map((e) => [String(e.id), e]));
}

/** The stats libwebrtc reports once DTLS is up (trimmed to what the binding reads). */
function connectedStats(remote = FP_A, local = FP_B): StatsReport {
  return report([
    {
      id: 'T01',
      type: 'transport',
      dtlsState: 'connected',
      localCertificateId: 'CFlocal',
      remoteCertificateId: 'CFremote',
      selectedCandidatePairId: 'CP1',
    },
    {
      id: 'CFremote',
      type: 'certificate',
      fingerprint: remote,
      fingerprintAlgorithm: 'sha-256',
      base64Certificate: 'MIIB…',
    },
    {
      id: 'CFlocal',
      type: 'certificate',
      fingerprint: local,
      fingerprintAlgorithm: 'sha-256',
      base64Certificate: 'MIIB…',
    },
    { id: 'D1', type: 'data-channel', label: 's', state: 'open' },
  ]);
}

describe('normalizeFingerprint', () => {
  it('lower-cases the algorithm and upper-cases the hex', () => {
    expect(normalizeFingerprint(' SHA-256 ', FP_A.toLowerCase())).toEqual({
      algorithm: 'sha-256',
      value: FP_A,
    });
  });

  it('accepts sha-384 and sha-512 digests of the right length', () => {
    const hex = (n: number) => Array.from({ length: n }, () => 'AB').join(':');
    expect(normalizeFingerprint('sha-384', hex(48))?.algorithm).toBe('sha-384');
    expect(normalizeFingerprint('sha-512', hex(64))?.algorithm).toBe('sha-512');
    expect(normalizeFingerprint('sha-384', hex(32))).toBeNull();
  });

  it('refuses weak or unknown hashes', () => {
    const sha1 = Array.from({ length: 20 }, () => 'AB').join(':');
    expect(normalizeFingerprint('sha-1', sha1)).toBeNull();
    expect(normalizeFingerprint('md5', FP_A)).toBeNull();
    expect(normalizeFingerprint('', FP_A)).toBeNull();
  });

  it('refuses malformed values', () => {
    expect(normalizeFingerprint('sha-256', FP_A.replace(/:/g, ''))).toBeNull();
    expect(normalizeFingerprint('sha-256', `${FP_A}:00`)).toBeNull();
    expect(normalizeFingerprint('sha-256', FP_A.replace('6B', 'G1'))).toBeNull();
    expect(normalizeFingerprint('sha-256', FP_A.replace('6B', '6'))).toBeNull();
  });
});

describe('parseSdpFingerprints', () => {
  it('reads the fingerprint of a data-channel offer', () => {
    expect(parseSdpFingerprints(sdpWith(`a=fingerprint:sha-256 ${FP_A}`))).toEqual([
      { algorithm: 'sha-256', value: FP_A },
    ]);
  });

  it('reads session- and media-level lines, LF or CRLF, without duplicates', () => {
    const sdp = `v=0\na=fingerprint:sha-256 ${FP_A}\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=fingerprint:SHA-256 ${FP_A.toLowerCase()}\n`;
    expect(parseSdpFingerprints(sdp)).toEqual([{ algorithm: 'sha-256', value: FP_A }]);
  });

  it('keeps distinct fingerprints in order', () => {
    expect(
      parseSdpFingerprints(
        sdpWith(`a=fingerprint:sha-256 ${FP_A}`, `a=fingerprint:sha-256 ${FP_B}`),
      ),
    ).toEqual([
      { algorithm: 'sha-256', value: FP_A },
      { algorithm: 'sha-256', value: FP_B },
    ]);
  });

  it('drops refused and malformed lines', () => {
    const sha1 = Array.from({ length: 20 }, () => 'AB').join(':');
    expect(
      parseSdpFingerprints(
        sdpWith(`a=fingerprint:sha-1 ${sha1}`, 'a=fingerprint:sha-256', 'a=fingerprint: '),
      ),
    ).toEqual([]);
    expect(parseSdpFingerprints('')).toEqual([]);
  });
});

describe('transportCertificateFingerprint', () => {
  it('follows remoteCertificateId and localCertificateId', () => {
    const stats = connectedStats();
    expect(transportCertificateFingerprint(stats, 'remote')).toEqual({
      algorithm: 'sha-256',
      value: FP_A,
    });
    expect(transportCertificateFingerprint(stats, 'local')?.value).toBe(FP_B);
  });

  it('is null before DTLS connects', () => {
    const stats = report([
      { id: 'T01', type: 'transport', dtlsState: 'connecting' },
      { id: 'CFremote', type: 'certificate', fingerprint: FP_A, fingerprintAlgorithm: 'sha-256' },
    ]);
    expect(transportCertificateFingerprint(stats, 'remote')).toBeNull();
    expect(transportCertificateFingerprint(new Map(), 'remote')).toBeNull();
  });

  it('fails closed on a connected transport without a usable certificate', () => {
    const base = { id: 'T01', type: 'transport', dtlsState: 'connected' };
    expect(transportCertificateFingerprint(report([base]), 'remote')).toBeNull();
    expect(
      transportCertificateFingerprint(
        report([
          { ...base, remoteCertificateId: 'X' },
          { id: 'X', type: 'codec' },
        ]),
        'remote',
      ),
    ).toBeNull();
    expect(
      transportCertificateFingerprint(
        report([
          { ...base, remoteCertificateId: 'X' },
          { id: 'X', type: 'certificate', fingerprint: FP_A },
        ]),
        'remote',
      ),
    ).toBeNull();
    expect(
      transportCertificateFingerprint(
        report([
          { ...base, remoteCertificateId: 'X' },
          { id: 'X', type: 'certificate', fingerprint: 'zz', fingerprintAlgorithm: 'sha-256' },
        ]),
        'remote',
      ),
    ).toBeNull();
  });

  it('fails closed when two connected transports disagree, agrees when they match', () => {
    const t = (id: string, cert: string) => ({
      id,
      type: 'transport',
      dtlsState: 'connected',
      remoteCertificateId: cert,
    });
    const c = (id: string, fp: string) => ({
      id,
      type: 'certificate',
      fingerprint: fp,
      fingerprintAlgorithm: 'sha-256',
    });
    expect(
      transportCertificateFingerprint(
        report([t('T1', 'C1'), t('T2', 'C2'), c('C1', FP_A), c('C2', FP_B)]),
        'remote',
      ),
    ).toBeNull();
    expect(
      transportCertificateFingerprint(
        report([t('T1', 'C1'), t('T2', 'C2'), c('C1', FP_A), c('C2', FP_A)]),
        'remote',
      )?.value,
    ).toBe(FP_A);
  });
});

describe('sdpFingerprintBinding (R-RTC-2)', () => {
  it('accepts the certificate the authenticated SDP announced', () => {
    expect(
      sdpFingerprintBinding(sdpWith(`a=fingerprint:sha-256 ${FP_A}`), connectedStats()),
    ).toEqual({ ok: true, fingerprint: { algorithm: 'sha-256', value: FP_A } });
  });

  it('rejects a different certificate (a relay or signalling MITM)', () => {
    expect(
      sdpFingerprintBinding(sdpWith(`a=fingerprint:sha-256 ${FP_B}`), connectedStats()),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects an SDP that lists a second, different fingerprint of the same hash', () => {
    const sdp = sdpWith(`a=fingerprint:sha-256 ${FP_A}`, `a=fingerprint:sha-256 ${FP_B}`);
    expect(sdpFingerprintBinding(sdp, connectedStats())).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects when the SDP only has a fingerprint of another hash', () => {
    const sha512 = Array.from({ length: 64 }, () => 'CD').join(':');
    expect(
      sdpFingerprintBinding(sdpWith(`a=fingerprint:sha-512 ${sha512}`), connectedStats()),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('fails closed without an SDP fingerprint or before DTLS connects', () => {
    expect(sdpFingerprintBinding(sdpWith(), connectedStats())).toEqual({
      ok: false,
      reason: 'no-sdp-fingerprint',
    });
    expect(sdpFingerprintBinding(sdpWith(`a=fingerprint:sha-256 ${FP_A}`), new Map())).toEqual({
      ok: false,
      reason: 'not-connected',
    });
  });
});
