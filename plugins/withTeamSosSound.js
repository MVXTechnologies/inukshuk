// @ts-check
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');

/**
 * Bundle the Team SOS alarm tone (#708) as a notification sound: Android
 * `res/raw/team_sos.wav` (the "Team SOS" channel's sound) and a resource of
 * the iOS app target (the SOS notification's `sound`).
 *
 * Only the sound part of expo-notifications' config plugin, on purpose:
 * listing that plugin in app.config.ts would also add `aps-environment`
 * after `withoutPushEntitlement` has run (the mods order), and the store
 * profile has no Push capability (2.5.0). The tone is ours, synthesized by
 * scripts/audio/sosTone.js.
 */
const SOUNDS = ['./assets/sounds/team_sos.wav'];

const ios = () => require('expo-notifications/plugin/build/withNotificationsIOS');
const android = () => require('expo-notifications/plugin/build/withNotificationsAndroid');

/** @type {import('@expo/config-plugins').ConfigPlugin} */
const withTeamSosSound = (config) => {
  config = withXcodeProject(config, (c) => {
    c.modResults = ios().setNotificationSounds(c.modRequest.projectRoot, {
      sounds: SOUNDS,
      project: c.modResults,
      projectName: c.modRequest.projectName,
    });
    return c;
  });
  return withDangerousMod(config, [
    'android',
    (c) => {
      android().setNotificationSounds(c.modRequest.projectRoot, SOUNDS);
      return c;
    },
  ]);
};

module.exports = withTeamSosSound;
module.exports.SOUNDS = SOUNDS;
