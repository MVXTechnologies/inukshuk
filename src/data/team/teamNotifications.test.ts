/**
 * The team notification channels and contents (#708), against a fake
 * expo-notifications module.
 */
import { Platform } from 'react-native';

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
  dismissTeamNotification,
  notifyTeam,
  RALLY_CHANNEL,
  resetTeamNotificationsForTests,
  setInAppAlarm,
  SOS_CHANNEL,
  SOS_SOUND,
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
