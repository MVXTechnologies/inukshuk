/**
 * @jest-environment node
 */
const { describe, expect, it, jest } = require('@jest/globals');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const mockIos = jest.fn((_root, o) => `${o.project}+sounds`);
const mockAndroid = jest.fn();
const mockMods = { ios: null, android: null };
jest.mock('@expo/config-plugins', () => ({
  withXcodeProject: (config, fn) => {
    mockMods.ios = fn;
    return config;
  },
  withDangerousMod: (config, [platform, fn]) => {
    mockMods[platform] = fn;
    return config;
  },
}));
jest.mock('expo-notifications/plugin/build/withNotificationsIOS', () => ({
  setNotificationSounds: mockIos,
}));
jest.mock('expo-notifications/plugin/build/withNotificationsAndroid', () => ({
  setNotificationSounds: mockAndroid,
}));

const withTeamSosSound = require('./withTeamSosSound');

describe('withTeamSosSound (#708)', () => {
  it('adds the bundled tone to the iOS target and Android res/raw, nothing else', () => {
    const config = { name: 'Inukshuk', slug: 'inukshuk' };
    expect(withTeamSosSound(config)).toBe(config);
    const modRequest = { projectRoot: '/root', projectName: 'Inukshuk' };
    const ios = mockMods.ios({ modRequest, modResults: 'project' });
    expect(ios.modResults).toBe('project+sounds');
    expect(mockIos).toHaveBeenCalledWith('/root', {
      sounds: ['./assets/sounds/team_sos.wav'],
      project: 'project',
      projectName: 'Inukshuk',
    });
    mockMods.android({ modRequest });
    expect(mockAndroid).toHaveBeenCalledWith('/root', ['./assets/sounds/team_sos.wav']);
  });

  it('points at a file that exists, with a valid Android resource name', () => {
    for (const s of withTeamSosSound.SOUNDS) {
      expect(existsSync(resolve(require.resolve('../package.json'), '..', s))).toBe(true);
      expect(s.split('/').pop()).toMatch(/^[a-z][a-z0-9_]*\.wav$/);
    }
  });
});
