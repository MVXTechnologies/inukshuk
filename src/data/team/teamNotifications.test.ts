/**
 * The team notification channels and contents (#708), against a fake
 * expo-notifications module.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppState, Platform, Vibration } from 'react-native';

const mockN = {
  AndroidImportance: { HIGH: 4, MAX: 5 },
  AndroidAudioUsage: { ALARM: 4 },
  AndroidAudioContentType: { SONIFICATION: 4 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  AndroidNotificationPriority: { HIGH: 'high', MAX: 'max' },
  setNotificationHandler: jest.fn<void, [unknown]>(),
  setNotificationChannelAsync: jest.fn<Promise<null>, [string, Record<string, unknown>]>(
    async () => null,
  ),
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn<Promise<string>, [Record<string, unknown>]>(async () => 'id'),
  dismissNotificationAsync: jest.fn<Promise<void>, [string]>(async () => undefined),
};
jest.mock('expo', () => ({ requireOptionalNativeModule: () => ({}) }));
jest.mock('expo-notifications', () => mockN);

// eslint-disable-next-line import/first
import {
  armSos,
  buzzRally,
  dismissTeamNotification,
  notifyTeam,
  RALLY_CHANNEL,
  RALLY_VIBRATION,
  resetTeamNotificationsForTests,
  setInAppAlarm,
  silenceSos,
  SOS_CHANNEL,
  SOS_SOUND,
  SOS_TONE_MS,
  TEAM_CHANNEL,
} from './teamNotifications';

const setOS = (os: 'android' | 'ios') =>
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

beforeEach(() => {
  resetTeamNotificationsForTests();
  jest.clearAllMocks();
});

describe('team notification channels (#708)', () => {
  it('Android: Team SOS (max, our tone on the alarm stream, long vibration), Team rally, team', async () => {
    setOS('android');
    await notifyTeam({ title: 'x', body: 'y', url: '/team/chat' });
    const channels = new Map(
      mockN.setNotificationChannelAsync.mock.calls.map((c) => [c[0], c[1]] as const),
    );
    expect([...channels.keys()].sort()).toEqual([RALLY_CHANNEL, SOS_CHANNEL, TEAM_CHANNEL].sort());
    expect(channels.get(SOS_CHANNEL)).toMatchObject({
      name: 'Team SOS',
      importance: 5,
      sound: SOS_SOUND,
      audioAttributes: { usage: 4 },
      lockscreenVisibility: 1,
      enableVibrate: true,
    });
    const sosVib = (channels.get(SOS_CHANNEL) as { vibrationPattern: number[] }).vibrationPattern;
    // Long and repeated: at least 9 pulses, over 8 s of pattern.
    expect(sosVib.filter((_, i) => i % 2 === 1).length).toBeGreaterThanOrEqual(9);
    expect(sosVib.reduce((a, b) => a + b, 0)).toBeGreaterThan(8000);
    expect(channels.get(RALLY_CHANNEL)).toMatchObject({
      name: 'Team rally',
      importance: 4,
      sound: 'default',
    });
    // The one shared notification went to the team channel.
    expect(mockN.scheduleNotificationAsync.mock.calls[0]![0]).toMatchObject({
      trigger: { channelId: TEAM_CHANNEL },
      content: { sound: 'default', data: { url: '/team/chat', team: true, channel: 'team' } },
    });
  });

  it('an SOS: its channel, our tone, time-sensitive, its entity as identifier; a rally its own', async () => {
    setOS('android');
    await notifyTeam({
      title: 'SOS · Julie',
      body: 'Needs help',
      url: '/team/sos/j/s1',
      channel: 'sos',
      identifier: 'sos:j:s1',
    });
    await notifyTeam({
      title: 'Gather',
      body: 'Noé',
      url: '/team/rally/n/r1',
      channel: 'rally',
      identifier: 'rly:n:r1',
    });
    const [sos, rally] = mockN.scheduleNotificationAsync.mock.calls.map((c) => c[0]);
    expect(sos).toMatchObject({
      identifier: 'sos:j:s1',
      trigger: { channelId: SOS_CHANNEL },
      content: { sound: SOS_SOUND, interruptionLevel: 'timeSensitive', priority: 'max' },
    });
    expect(rally).toMatchObject({
      identifier: 'rly:n:r1',
      trigger: { channelId: RALLY_CHANNEL },
      content: { sound: 'default', priority: 'high' },
    });
    expect((rally as { content: object }).content).not.toHaveProperty('interruptionLevel');
    await dismissTeamNotification('sos:j:s1');
    expect(mockN.dismissNotificationAsync).toHaveBeenCalledWith('sos:j:s1');
  });

  it('iOS: no channels, a null trigger; the SOS banner hides while the in-app alarm is up', async () => {
    setOS('ios');
    await notifyTeam({ title: 'SOS', body: 'b', url: '/x', channel: 'sos', identifier: 's' });
    expect(mockN.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(mockN.scheduleNotificationAsync.mock.calls[0]![0]).toMatchObject({ trigger: null });
    const { handleNotification } = mockN.setNotificationHandler.mock.calls[0]![0] as {
      handleNotification: (n: unknown) => Promise<{ shouldShowBanner: boolean }>;
    };
    const note = (channel: string) => ({ request: { content: { data: { channel } } } });
    expect((await handleNotification(note('sos'))).shouldShowBanner).toBe(true);
    setInAppAlarm(true);
    expect(await handleNotification(note('sos'))).toMatchObject({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: true,
    });
    expect((await handleNotification(note('team'))).shouldShowBanner).toBe(true);
  });

  it('never throws: a scheduler error is swallowed', async () => {
    setOS('android');
    mockN.scheduleNotificationAsync.mockRejectedValueOnce(new Error('busy'));
    mockN.dismissNotificationAsync.mockRejectedValueOnce(new Error('gone'));
    await expect(notifyTeam({ title: 't', body: 'b', url: '/' })).resolves.toBeUndefined();
    await expect(dismissTeamNotification('x')).resolves.toBeUndefined();
  });
});

describe('the SOS tone loop and Acknowledge (#708, #752)', () => {
  const sosNote = { title: 'SOS', body: 'b', url: '/x', channel: 'sos' as const };

  it('SOS_TONE_MS is the bundled tone’s exact length (the re-sound interval)', () => {
    const wav = readFileSync(join(__dirname, '../../../assets/sounds/team_sos.wav'));
    const ms = ((wav.readUInt32LE(40) / 2) * 1000) / wav.readUInt32LE(24);
    expect(ms).toBe(SOS_TONE_MS);
    expect(SOS_TONE_MS).toBe(8_000);
    // iOS plays a notification sound only if it is under 30 s.
    expect(SOS_TONE_MS).toBeLessThan(30_000);
  });

  it('silenceSos removes the notification at once and stops every re-post of it', async () => {
    setOS('android');
    await notifyTeam({ ...sosNote, identifier: 'sos:j:s1' });
    expect(mockN.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    silenceSos('sos:j:s1');
    // Cancelling the notification is what cuts its sound mid-play.
    expect(mockN.dismissNotificationAsync).toHaveBeenCalledWith('sos:j:s1');
    await notifyTeam({ ...sosNote, identifier: 'sos:j:s1' });
    expect(mockN.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    // Another SOS, and other channels, still sound.
    await notifyTeam({ ...sosNote, identifier: 'sos:n:s2' });
    await notifyTeam({ title: 't', body: 'b', url: '/', identifier: 'sos:j:s1' });
    expect(mockN.scheduleNotificationAsync).toHaveBeenCalledTimes(3);
  });

  it('a re-post already in flight when Acknowledge lands never sounds', async () => {
    setOS('android');
    let grant: (v: { granted: true }) => void = () => undefined;
    mockN.getPermissionsAsync.mockImplementationOnce(
      () => new Promise((r) => (grant = r)) as Promise<{ granted: true }>,
    );
    const posting = notifyTeam({ ...sosNote, identifier: 'sos:j:s1' });
    // Parked on the permission check (after the channels are set up).
    for (let i = 0; i < 50 && mockN.getPermissionsAsync.mock.calls.length === 0; i++)
      await Promise.resolve();
    expect(mockN.getPermissionsAsync).toHaveBeenCalledTimes(1);
    silenceSos('sos:j:s1');
    grant({ granted: true });
    await posting;
    expect(mockN.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('armSos (a new ring after a resolve, #752) lets the same SOS sound again', async () => {
    setOS('ios');
    silenceSos('sos:j:s1');
    await notifyTeam({ ...sosNote, identifier: 'sos:j:s1' });
    expect(mockN.scheduleNotificationAsync).not.toHaveBeenCalled();
    armSos('sos:j:s1');
    await notifyTeam({ ...sosNote, identifier: 'sos:j:s1' });
    expect(mockN.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });
});

describe('the in-app rally buzz (#743)', () => {
  const setApp = (state: 'active' | 'background') =>
    Object.defineProperty(AppState, 'currentState', { value: state, configurable: true });
  afterEach(() => setApp('active'));

  it('vibrates the rally pattern once with the app in front, never in the background', () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    setApp('active');
    buzzRally();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(RALLY_VIBRATION);
    setApp('background');
    buzzRally();
    expect(vibrate).toHaveBeenCalledTimes(1);
    // No vibrator: never throws.
    setApp('active');
    vibrate.mockImplementation(() => {
      throw new Error('no vibrator');
    });
    expect(() => buzzRally()).not.toThrow();
    vibrate.mockRestore();
  });
});
