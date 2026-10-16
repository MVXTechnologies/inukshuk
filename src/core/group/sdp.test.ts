import {
  allowCandidate,
  candidateType,
  filterSdpCandidates,
  normalizeFingerprint,
  selectedPathKind,
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

describe('ICE candidate filter (R-RTC-3)', () => {
  const host = 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0';
  const mdns = 'candidate:2 1 udp 2122260223 4f2a.local 54321 typ host';
  const srflx =
    'candidate:3 1 udp 1686052607 203.0.113.5 4000 typ srflx raddr 192.168.1.20 rport 54321';
  const relay =
    'candidate:4 1 udp 41885439 198.51.100.7 3478 typ relay raddr 203.0.113.5 rport 4000';

  it('reads the candidate type, failing closed on junk', () => {
    expect(candidateType(host)).toBe('host');
    expect(candidateType(`a=${srflx}`)).toBe('srflx');
    expect(candidateType(relay)).toBe('relay');
    for (const bad of [
      '',
      'candidate:',
      'candidate:1 1 udp 1 1.2.3.4 5 kind host',
      'x typ host',
      'candidate:1 1 udp 1 1.2.3.4 5 typ magic',
    ]) {
      expect(candidateType(bad)).toBeNull();
    }
  });

  it('never lets a host candidate out; relay policy keeps TURN only', () => {
    expect(allowCandidate(host, 'direct')).toBe(false);
    expect(allowCandidate(mdns, 'direct')).toBe(false);
    expect(allowCandidate(srflx, 'direct')).toBe(true);
    expect(allowCandidate(relay, 'direct')).toBe(true);
    expect(allowCandidate(srflx, 'relay')).toBe(false);
    expect(allowCandidate(relay, 'relay')).toBe(true);
    expect(allowCandidate('garbage', 'direct')).toBe(false);
    expect(allowCandidate('', 'relay')).toBe(true);
  });

  it('strips refused candidate lines from an SDP, keeping everything else', () => {
    const sdp = [
      'v=0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      `a=${host}`,
      `a=${srflx}`,
      `a=${relay}`,
      'a=fingerprint:sha-256 AB',
      '',
    ].join('\r\n');
    expect(filterSdpCandidates(sdp, 'direct')).toBe(
      [
        'v=0',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        `a=${srflx}`,
        `a=${relay}`,
        'a=fingerprint:sha-256 AB',
        '',
      ].join('\r\n'),
    );
    expect(filterSdpCandidates(sdp, 'relay')).not.toContain('typ srflx');
    expect(filterSdpCandidates('v=0\na=' + host + '\n', 'direct')).toBe('v=0\n');
  });
});

describe('selectedPathKind', () => {
  const report = (entries: Record<string, unknown>[]): StatsReport =>
    new Map(entries.map((e) => [e['id'] as string, e]));
  const cands = (local: string, remote: string) => [
    { id: 'L', type: 'local-candidate', candidateType: local },
    { id: 'R', type: 'remote-candidate', candidateType: remote },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' },
  ];

  it('reads the transport’s selected pair: relay when either end is TURN', () => {
    const t = { id: 'T', type: 'transport', selectedCandidatePairId: 'P' };
    expect(selectedPathKind(report([t, ...cands('srflx', 'prflx')]))).toBe('direct');
    expect(selectedPathKind(report([t, ...cands('relay', 'srflx')]))).toBe('relay');
    expect(selectedPathKind(report([t, ...cands('srflx', 'relay')]))).toBe('relay');
  });

  it('falls back to a nominated, succeeded pair; null when none or incomplete', () => {
    const pair = {
      id: 'P',
      type: 'candidate-pair',
      localCandidateId: 'L',
      remoteCandidateId: 'R',
      nominated: true,
      state: 'succeeded',
    };
    const [l, r] = cands('relay', 'relay');
    expect(selectedPathKind(report([l!, r!, pair]))).toBe('relay');
    expect(selectedPathKind(report([l!, r!, { ...pair, state: 'in-progress' }]))).toBeNull();
    expect(selectedPathKind(report([l!, pair]))).toBeNull();
    expect(selectedPathKind(new Map())).toBeNull();
  });
});
