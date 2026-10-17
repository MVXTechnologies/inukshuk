import {
  EMPTY_UPDATE_CHECK_STATE,
  PLAY_INSTALL_STATUS,
  UPDATE_CHECK_INTERVAL_MS,
  appStoreUrl,
  compareVersions,
  fakeStoreAnswer,
  iosOfferFromLookup,
  isNewerVersion,
  isOfferNewer,
  isUpdateCheckDue,
  isUpdatePromptVisible,
  offerKey,
  parseItunesLookup,
  parseUpdatePromptLink,
  phaseFromPlayStatus,
  playStoreUrls,
  sanitizeUpdateCheckState,
  updatePromptCopy,
  type StoreOffer,
} from './storeUpdate';

const IOS: StoreOffer = { platform: 'ios', version: '2.7.1', trackId: 6740000000 };
const ANDROID: StoreOffer = { platform: 'android', versionCode: 120 };

describe('compareVersions', () => {
  it('orders dotted numeric versions part by part, not as strings', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('2.7.0', '2.7.1')).toBe(-1);
    expect(compareVersions('2.7.1', '2.7.1')).toBe(0);
    expect(compareVersions('3', '2.99.99')).toBe(1);
  });

  it('treats missing parts as zero', () => {
    expect(compareVersions('2.7', '2.7.0')).toBe(0);
    expect(compareVersions('2.7.0.1', '2.7')).toBe(1);
  });

  it('refuses anything that is not a plain version', () => {
    expect(compareVersions('2.7.1-beta', '2.7.0')).toBeNull();
    expect(compareVersions('', '2.7.0')).toBeNull();
    expect(compareVersions('2.7.0', 'v2')).toBeNull();
    expect(compareVersions('1.2.3.4.5', '1')).toBeNull();
  });

  it('isNewerVersion is strictly greater and false on junk', () => {
    expect(isNewerVersion('2.7.1', '2.7.0')).toBe(true);
    expect(isNewerVersion('2.7.0', '2.7.0')).toBe(false);
    expect(isNewerVersion('2.6.9', '2.7.0')).toBe(false);
    expect(isNewerVersion('junk', '2.7.0')).toBe(false);
  });
});

describe('isUpdateCheckDue', () => {
  const now = 1_800_000_000_000;
  const at = (lastCheckAt: number | null) => ({ lastCheckAt, downloadPending: false });

  it('checks on a first launch', () => {
    expect(isUpdateCheckDue(at(null), now, false)).toBe(true);
  });

  it('never checks twice in one launch', () => {
    expect(isUpdateCheckDue(at(null), now, true)).toBe(false);
    expect(isUpdateCheckDue(at(now - 2 * UPDATE_CHECK_INTERVAL_MS), now, true)).toBe(false);
  });

  it('waits a full day between checks', () => {
    expect(isUpdateCheckDue(at(now - UPDATE_CHECK_INTERVAL_MS + 1), now, false)).toBe(false);
    expect(isUpdateCheckDue(at(now - UPDATE_CHECK_INTERVAL_MS), now, false)).toBe(true);
  });

  it('an accepted Play download is checked again at the next launch, once', () => {
    const pending = { lastCheckAt: now - 1000, downloadPending: true };
    expect(isUpdateCheckDue(pending, now, false)).toBe(true);
    expect(isUpdateCheckDue(pending, now, true)).toBe(false);
  });

  it('a clock that went backwards does not silence the check', () => {
    expect(isUpdateCheckDue(at(now + 60_000), now, false)).toBe(true);
    expect(isUpdateCheckDue(at(Number.NaN), now, false)).toBe(true);
  });
});

describe('offers', () => {
  it('keys a dismissal per store version', () => {
    expect(offerKey(IOS)).toBe('ios:2.7.1');
    expect(offerKey(ANDROID)).toBe('android:120');
  });

  it('an iPhone offer is newer than the running native version only', () => {
    expect(isOfferNewer(IOS, { version: '2.7.0', build: null })).toBe(true);
    expect(isOfferNewer(IOS, { version: '2.7.1', build: null })).toBe(false);
    expect(isOfferNewer(IOS, { version: null, build: null })).toBe(false);
  });

  it('an Android offer compares versionCodes', () => {
    expect(isOfferNewer(ANDROID, { version: '2.7.0', build: '119' })).toBe(true);
    expect(isOfferNewer(ANDROID, { version: '2.7.0', build: '120' })).toBe(false);
    expect(isOfferNewer(ANDROID, { version: '2.7.0', build: null })).toBe(false);
    expect(isOfferNewer(ANDROID, { version: '2.7.0', build: 'x' })).toBe(false);
  });

  it('builds the store addresses', () => {
    expect(appStoreUrl(123)).toBe('https://apps.apple.com/app/id123');
    expect(playStoreUrls('com.inukshuk.app')).toEqual({
      market: 'market://details?id=com.inukshuk.app',
      web: 'https://play.google.com/store/apps/details?id=com.inukshuk.app',
    });
  });
});

describe('parseItunesLookup', () => {
  it('reads the first result', () => {
    expect(
      parseItunesLookup({
        resultCount: 1,
        results: [{ version: '2.7.1', trackId: 42, minimumOsVersion: '17.0', other: 1 }],
      }),
    ).toEqual({ version: '2.7.1', trackId: 42, minimumOsVersion: '17.0' });
    expect(parseItunesLookup({ results: [{ version: ' 2.7.1 ', trackId: 42 }] })).toEqual({
      version: '2.7.1',
      trackId: 42,
      minimumOsVersion: null,
    });
  });

  it('returns null for an empty or malformed answer', () => {
    expect(parseItunesLookup(null)).toBeNull();
    expect(parseItunesLookup('x')).toBeNull();
    expect(parseItunesLookup({ resultCount: 0, results: [] })).toBeNull();
    expect(parseItunesLookup({ results: 'x' })).toBeNull();
    expect(parseItunesLookup({ results: [null] })).toBeNull();
    expect(parseItunesLookup({ results: [{ version: 'beta', trackId: 42 }] })).toBeNull();
    expect(parseItunesLookup({ results: [{ version: '2.7.1', trackId: '42' }] })).toBeNull();
    expect(parseItunesLookup({ results: [{ version: '2.7.1', trackId: -1 }] })).toBeNull();
  });
});

describe('iosOfferFromLookup', () => {
  const running = { version: '2.7.0', build: '9' };
  const lookup = { version: '2.7.1', trackId: 42, minimumOsVersion: '17.0' };

  it('offers a newer version this iOS can install', () => {
    expect(iosOfferFromLookup(lookup, running, '18.2')).toEqual({
      platform: 'ios',
      version: '2.7.1',
      trackId: 42,
    });
    expect(iosOfferFromLookup(lookup, running, '17.0')).not.toBeNull();
  });

  it('stays quiet for the same or an older version', () => {
    expect(iosOfferFromLookup(lookup, { version: '2.7.1', build: null }, '18.2')).toBeNull();
    expect(iosOfferFromLookup(lookup, { version: '2.8.0', build: null }, '18.2')).toBeNull();
    expect(iosOfferFromLookup(null, running, '18.2')).toBeNull();
  });

  it('stays quiet when the store build needs a newer iOS', () => {
    expect(iosOfferFromLookup(lookup, running, '16.7')).toBeNull();
  });

  it('an unreadable OS version does not hide the offer', () => {
    expect(iosOfferFromLookup(lookup, running, 'unknown')).not.toBeNull();
    expect(
      iosOfferFromLookup({ ...lookup, minimumOsVersion: null }, running, '12.0'),
    ).not.toBeNull();
  });
});

describe('phaseFromPlayStatus', () => {
  it('maps a running download with its progress', () => {
    expect(phaseFromPlayStatus(PLAY_INSTALL_STATUS.DOWNLOADING, 25, 100)).toEqual({
      kind: 'downloading',
      fraction: 0.25,
    });
    expect(phaseFromPlayStatus(PLAY_INSTALL_STATUS.PENDING, 0, 0)).toEqual({
      kind: 'downloading',
      fraction: null,
    });
    expect(phaseFromPlayStatus(PLAY_INSTALL_STATUS.DOWNLOADING, 200, 100)).toEqual({
      kind: 'downloading',
      fraction: 1,
    });
  });

  it('downloaded asks for the restart; failed or cancelled offers again', () => {
    expect(phaseFromPlayStatus(PLAY_INSTALL_STATUS.DOWNLOADED, 1, 1)).toEqual({
      kind: 'downloaded',
    });
    expect(phaseFromPlayStatus(PLAY_INSTALL_STATUS.FAILED, 0, 0)).toEqual({ kind: 'available' });
    expect(phaseFromPlayStatus(PLAY_INSTALL_STATUS.CANCELED, 0, 0)).toEqual({ kind: 'available' });
  });

  it('ignores the statuses that need nothing on screen', () => {
    expect(phaseFromPlayStatus(PLAY_INSTALL_STATUS.INSTALLING, 0, 0)).toBeNull();
    expect(phaseFromPlayStatus(PLAY_INSTALL_STATUS.INSTALLED, 0, 0)).toBeNull();
    expect(phaseFromPlayStatus(0, 0, 0)).toBeNull();
  });
});

describe('updatePromptCopy', () => {
  it('names the version where the store gives it', () => {
    expect(updatePromptCopy(IOS, { kind: 'available' })).toEqual({
      text: 'Version 2.7.1 available',
      action: 'Update',
      actionLabel: 'Update Inukshuk',
    });
    expect(updatePromptCopy(ANDROID, { kind: 'available' })).toEqual({
      text: 'New version available',
      action: 'Update',
      actionLabel: 'Update Inukshuk',
    });
  });

  it('shows the download, then the restart', () => {
    expect(updatePromptCopy(ANDROID, { kind: 'downloading', fraction: 0.416 })).toEqual({
      text: 'Downloading update · 42 %',
      action: null,
      actionLabel: null,
    });
    expect(updatePromptCopy(ANDROID, { kind: 'downloading', fraction: null })).toEqual({
      text: 'Downloading update',
      action: null,
      actionLabel: null,
    });
    expect(updatePromptCopy(ANDROID, { kind: 'downloaded' })).toEqual({
      text: 'Update downloaded',
      action: 'Restart',
      actionLabel: 'Restart to update',
    });
  });
});

describe('isUpdatePromptVisible', () => {
  const base = { offer: IOS, dismissed: null, recording: false, sosActive: false };

  it('shows an offer that was not closed', () => {
    expect(isUpdatePromptVisible(base)).toBe(true);
    expect(isUpdatePromptVisible({ ...base, dismissed: 'ios:2.7.0' })).toBe(true);
  });

  it('a closed version stays closed; the next one shows', () => {
    expect(isUpdatePromptVisible({ ...base, dismissed: 'ios:2.7.1' })).toBe(false);
    expect(
      isUpdatePromptVisible({
        ...base,
        offer: { ...IOS, version: '2.7.2' },
        dismissed: 'ios:2.7.1',
      }),
    ).toBe(true);
  });

  it('never during a recording or a live SOS, or without an offer', () => {
    expect(isUpdatePromptVisible({ ...base, recording: true })).toBe(false);
    expect(isUpdatePromptVisible({ ...base, sosActive: true })).toBe(false);
    expect(isUpdatePromptVisible({ ...base, offer: null })).toBe(false);
  });
});

describe('sanitizeUpdateCheckState', () => {
  it('round-trips a valid state', () => {
    const state = { lastCheckAt: 5, offer: IOS, dismissed: 'ios:2.7.0', downloadPending: false };
    expect(sanitizeUpdateCheckState(state)).toEqual(state);
    const android = { lastCheckAt: 5, offer: ANDROID, dismissed: null, downloadPending: true };
    expect(sanitizeUpdateCheckState(android)).toEqual(android);
  });

  it('drops junk to the empty state, field by field', () => {
    expect(sanitizeUpdateCheckState(null)).toEqual(EMPTY_UPDATE_CHECK_STATE);
    expect(sanitizeUpdateCheckState([])).toEqual(EMPTY_UPDATE_CHECK_STATE);
    expect(
      sanitizeUpdateCheckState({
        lastCheckAt: 'x',
        offer: { platform: 'ios' },
        dismissed: 3,
        downloadPending: 'yes',
      }),
    ).toEqual(EMPTY_UPDATE_CHECK_STATE);
    expect(
      sanitizeUpdateCheckState({
        lastCheckAt: Infinity,
        offer: { platform: 'android', versionCode: 1.5 },
      }),
    ).toEqual(EMPTY_UPDATE_CHECK_STATE);
    expect(
      sanitizeUpdateCheckState({ offer: { platform: 'ios', version: '2.7.1', trackId: 0 } }),
    ).toEqual(EMPTY_UPDATE_CHECK_STATE);
    expect(sanitizeUpdateCheckState({ offer: null })).toEqual(EMPTY_UPDATE_CHECK_STATE);
  });
});

describe('parseUpdatePromptLink', () => {
  it('reads the faked state from the scheme link or the path', () => {
    expect(parseUpdatePromptLink('inukshuk://e2e/update-prompt?state=downloading')).toBe(
      'downloading',
    );
    expect(parseUpdatePromptLink('/e2e/update-prompt?state=downloaded')).toBe('downloaded');
    expect(parseUpdatePromptLink('e2e/update-prompt/?state=available&x=1')).toBe('available');
    expect(parseUpdatePromptLink('inukshuk://e2e/update-prompt')).toBe('available');
  });

  it('ignores every other link and unknown states', () => {
    expect(parseUpdatePromptLink('inukshuk://e2e/update-prompt?state=installed')).toBeNull();
    expect(parseUpdatePromptLink('inukshuk://convert?state=available')).toBeNull();
    expect(parseUpdatePromptLink('inukshuk://e2e/update-prompt-x?state=available')).toBeNull();
    expect(parseUpdatePromptLink('inukshuk://xe2e/update-prompt?state=available')).toBeNull();
    expect(parseUpdatePromptLink('content://downloads/e2e/update-prompt.gpx')).toBeNull();
  });
});

describe('fakeStoreAnswer', () => {
  it('fakes each state with the platform wording', () => {
    const ios = fakeStoreAnswer('available', 'ios');
    expect(updatePromptCopy(ios.offer, ios.phase).text).toBe('Version 2.7.1 available');
    const a = fakeStoreAnswer('available', 'android');
    expect(updatePromptCopy(a.offer, a.phase).text).toBe('New version available');
    const d = fakeStoreAnswer('downloading', 'android');
    expect(updatePromptCopy(d.offer, d.phase).text).toBe('Downloading update · 42 %');
    const r = fakeStoreAnswer('downloaded', 'android');
    expect(updatePromptCopy(r.offer, r.phase).action).toBe('Restart');
  });
});
