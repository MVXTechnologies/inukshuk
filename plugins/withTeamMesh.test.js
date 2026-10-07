const { describe, expect, it } = require('@jest/globals');
const withTeamMesh = require('./withTeamMesh');

const { applyTeamMeshInfoPlist, SERVICE_TYPE, ANDROID_PERMISSIONS } = withTeamMesh;

describe('withTeamMesh', () => {
  it('declares the Bonjour type and the Local Network purpose string', () => {
    const plist = applyTeamMeshInfoPlist({ CFBundleName: 'Inukshuk' });
    expect(plist.NSBonjourServices).toEqual(['_inukshuk-team._tcp']);
    expect(plist.NSLocalNetworkUsageDescription).toMatch(/team/);
    expect(plist.CFBundleName).toBe('Inukshuk');
  });

  it('keeps other Bonjour types and an existing purpose string, without duplicates', () => {
    const plist = applyTeamMeshInfoPlist({
      NSBonjourServices: ['_other._tcp', SERVICE_TYPE],
      NSLocalNetworkUsageDescription: 'Custom',
    });
    expect(plist.NSBonjourServices).toEqual(['_other._tcp', SERVICE_TYPE]);
    expect(plist.NSLocalNetworkUsageDescription).toBe('Custom');
  });

  it('matches the native service type (a DNS-SD name of at most 15 characters)', () => {
    expect(SERVICE_TYPE).toBe('_inukshuk-team._tcp');
    expect('inukshuk-team'.length).toBeLessThanOrEqual(15);
  });

  it('asks for normal Android permissions only', () => {
    expect(ANDROID_PERMISSIONS).not.toContain('android.permission.NEARBY_WIFI_DEVICES');
    expect(ANDROID_PERMISSIONS).toContain('android.permission.CHANGE_WIFI_MULTICAST_STATE');
  });

  it('adds the iOS and Android mods to an Expo config', () => {
    const config = withTeamMesh({ name: 'Inukshuk', slug: 'inukshuk' });
    expect(config.mods?.ios?.infoPlist).toBeDefined();
    expect(config.android?.permissions).toEqual(expect.arrayContaining(ANDROID_PERMISSIONS));
  });
});
