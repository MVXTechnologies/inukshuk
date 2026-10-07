import {
  activeProfile,
  correctionsOf,
  DEFAULT_GNSS_CONFIG,
  newProfile,
  profileProblem,
  sanitizeGnssConfig,
  type NtripProfile,
} from './config';
import {
  DEFAULT_PROJECT_DATUM_ID,
  isProjectDatumId,
  PROJECT_DATUM_OPTIONS,
  projectDatumOption,
} from './projectDatum';

const PROFILE: NtripProfile = {
  id: 'p1',
  label: 'RTK2go · LEVIS',
  presetId: 'rtk2go',
  host: 'rtk2go.com',
  port: 2101,
  version: 1,
  mountpoint: 'LEVIS',
  username: 'me@example.com',
  frame: { frame: 'csrs', epoch: 2010 },
  needsGga: true,
  ggaConsent: true,
  baseLat: 46.8,
  baseLon: -71.18,
};

describe('sanitizeGnssConfig', () => {
  it('junk → defaults, never throws', () => {
    for (const junk of [null, 42, 'x', [], { receiver: 3, profiles: 'no' }]) {
      expect(sanitizeGnssConfig(junk)).toEqual(DEFAULT_GNSS_CONFIG);
    }
  });

  it('keeps a valid file as it was', () => {
    const doc = {
      version: 1,
      receiver: { id: 'AA:BB', name: 'RTK Facet', transport: 'ble' },
      profiles: [PROFILE],
      activeProfileId: 'p1',
      projectDatumId: 'csrs-2010-cgvd2013',
      fallbackToPhone: false,
      phoneWhileGood: 'off',
    };
    expect(sanitizeGnssConfig(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('drops bad fields one by one', () => {
    const c = sanitizeGnssConfig({
      receiver: { id: '', name: 'x', transport: 'ble' },
      profiles: [
        PROFILE,
        PROFILE, // duplicate id
        { ...PROFILE, id: 'p2', host: 7 },
        {
          ...PROFILE,
          id: 'p3',
          label: 3,
          presetId: 5,
          version: 7,
          mountpoint: null,
          username: null,
          frame: { frame: 'mars', epoch: 2010 },
          needsGga: 'yes',
          baseLat: 99,
          baseLon: 500,
        },
        { ...PROFILE, id: 'p4', version: 2, frame: { frame: 'itrf2020', epoch: 'observation' } },
        { ...PROFILE, id: 'p5', frame: { frame: 'csrs', epoch: 1700 } },
        { ...PROFILE, id: 'p6', frame: { frame: 'csrs', epoch: 'soon' } },
        { ...PROFILE, id: 'p7', frame: 'csrs' },
        'nope',
      ],
      activeProfileId: 'gone',
      projectDatumId: 'mars-2000',
      fallbackToPhone: 'maybe',
      phoneWhileGood: 'eco',
    });
    expect(c.receiver).toBeNull();
    expect(c.profiles.map((p) => p.id)).toEqual(['p1', 'p3', 'p4', 'p5', 'p6', 'p7']);
    const p3 = c.profiles[1];
    expect(p3).toMatchObject({
      label: 'rtk2go.com',
      presetId: null,
      version: 1,
      mountpoint: '',
      username: '',
      frame: null,
      needsGga: false,
      baseLat: null,
      baseLon: null,
    });
    expect(c.profiles[2]).toMatchObject({
      version: 2,
      frame: { frame: 'itrf2020', epoch: 'observation' },
    });
    expect(c.profiles[3]?.frame).toEqual({ frame: 'csrs' });
    expect(c.profiles[4]?.frame).toEqual({ frame: 'csrs' });
    expect(c.profiles[5]?.frame).toBeNull();
    expect(c.activeProfileId).toBeNull();
    expect(c.projectDatumId).toBe(DEFAULT_PROJECT_DATUM_ID);
    expect(c.fallbackToPhone).toBe(true);
    expect(c.phoneWhileGood).toBe('standby');
    expect(sanitizeGnssConfig({ receiver: { id: 'x', transport: 'spp' } }).receiver).toEqual({
      id: 'x',
      name: '',
      transport: 'spp',
    });
    expect(sanitizeGnssConfig({ receiver: { id: 'x', transport: 'usb' } }).receiver).toBeNull();
    expect(sanitizeGnssConfig({ receiver: [] }).receiver).toBeNull();
  });
});

describe('profiles', () => {
  it('the active profile and the corrections frame it gives `receiverFrame`', () => {
    const c = { ...DEFAULT_GNSS_CONFIG, profiles: [PROFILE] };
    expect(activeProfile(c)).toBeNull();
    expect(correctionsOf(c)).toBe('none');
    const on = { ...c, activeProfileId: 'p1' };
    expect(activeProfile(on)).toBe(PROFILE);
    expect(correctionsOf(on)).toEqual({ frame: 'csrs', epoch: 2010 });
    expect(correctionsOf({ ...on, profiles: [{ ...PROFILE, frame: null }] })).toBeNull();
  });

  it('new profiles from a preset, or blank', () => {
    expect(newProfile('a', 'polaris')).toMatchObject({
      host: 'polaris.pointonenav.com',
      version: 2,
      frame: { frame: 'itrf2014', epoch: 'observation' },
      presetId: 'polaris',
    });
    expect(newProfile('b', null)).toMatchObject({
      label: 'NTRIP caster',
      host: '',
      port: 2101,
      presetId: null,
      frame: null,
    });
    expect(newProfile('c', 'nope').presetId).toBeNull();
  });

  it('what is wrong with a profile, in the request builder’s own words', () => {
    expect(profileProblem(PROFILE)).toBeNull();
    expect(profileProblem({ ...PROFILE, host: ' ' })).toBe('Enter the caster address');
    expect(profileProblem({ ...PROFILE, mountpoint: '' })).toBe('Choose a mountpoint');
    expect(profileProblem({ ...PROFILE, mountpoint: '' }, { needMountpoint: false })).toBeNull();
    expect(profileProblem({ ...PROFILE, port: 0 })).toBe('Invalid caster port');
    expect(profileProblem({ ...PROFILE, username: 'a:b' })).toMatch(/":"/);
  });
});

describe('project datum options', () => {
  it('ids are unique; unknown ids fall back to WGS 84', () => {
    const ids = PROJECT_DATUM_OPTIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(projectDatumOption('csrs-1997').datum).toEqual({
      frame: 'csrs',
      epoch: 1997,
      height: 'ell',
    });
    expect(projectDatumOption('nope').id).toBe('wgs84');
    expect(projectDatumOption(null).id).toBe('wgs84');
    expect(isProjectDatumId('itrf2020')).toBe(true);
    expect(isProjectDatumId('nope')).toBe(false);
    expect(isProjectDatumId(3)).toBe(false);
  });
});
