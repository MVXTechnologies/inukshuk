/**
 * System notifications for team mode (#589, #708): LOCAL notifications raised
 * by team ops this phone received over the LAN or hotspot — no push server,
 * no remote token, no `aps-environment` entitlement (`withoutPushEntitlement`
 * strips what expo-notifications' plugin adds; the plugin is listed only for
 * the bundled SOS tone).
 *
 * - Only `alert`-level team events notify (the core's routing: urgent,
 *   mentions, important from an admin, a comment on my trail or photo, an
 *   SOS, a rally point). Chatter in a team of more than 30 never does.
 * - **Three Android channels** (`@core/teamui/alertLedger` picks one):
 *   - "Team messages and comments": high, a short buzz.
 *   - "Team SOS": max importance, our own alarm tone (`team_sos.wav`,
 *     synthesized by `scripts/audio/sosTone.js`) on the alarm stream, a long
 *     vibration repeated three times, shown on the lock screen.
 *   - "Team rally": high, the default sound, its own vibration.
 *   On iOS the SOS is time-sensitive (breaks through Focus; needs the Time
 *   Sensitive Notifications capability) with the same tone.
 * - An SOS or rally notification carries its entity as its identifier, so it
 *   is cleared ({@link dismissTeamNotification}) when resolved or ended.
 * - Shown in the foreground too, except the system banner of an SOS while
 *   the in-app alarm banner is up ({@link setInAppAlarm}): the sound still
 *   plays, the list still has it.
 * - The permission is asked the first time it is needed, once.
 * - Tapping one opens the route it carries (`data.url`).
 *
 * Loaded lazily and optionally: a binary without the module (an OTA onto a
 * pre-2.5.0 build) simply never shows system notifications.
 */
import type { AlertChannel } from '@core/teamui/alertLedger';
import { requireOptionalNativeModule } from 'expo';
import type * as NotificationsModule from 'expo-notifications';
import { AppState, Platform, Vibration } from 'react-native';

type Api = typeof NotificationsModule;

let cached: Api | null | undefined;
let configured = false;
let asked = false;
let inAppAlarm = false;

function api(): Api | null {
  if (cached !== undefined) return cached;
  try {
    cached =
      requireOptionalNativeModule('ExpoNotificationScheduler') === null
        ? null
        : // eslint-disable-next-line @typescript-eslint/no-require-imports
          (require('expo-notifications') as Api);
  } catch {
    cached = null;
  }
  return cached;
}

export const TEAM_CHANNEL = 'team';
export const SOS_CHANNEL = 'team-sos';
export const RALLY_CHANNEL = 'team-rally';

/** The bundled SOS tone (res/raw on Android, the app bundle on iOS). */
export const SOS_SOUND = 'team_sos.wav';

/** Long, distinctive, three times: ~6 s of "someone needs help". */
export const SOS_VIBRATION = [
  0, 900, 250, 900, 250, 900, 700, 900, 250, 900, 250, 900, 700, 900, 250, 900, 250, 900,
];
/** Short-short-long: a call to gather, unlike a message's two buzzes. */
export const RALLY_VIBRATION = [0, 180, 120, 180, 120, 600];
const TEAM_VIBRATION = [0, 250, 150, 250];

const CHANNEL_ID: Record<AlertChannel, string> = {
  team: TEAM_CHANNEL,
  sos: SOS_CHANNEL,
  rally: RALLY_CHANNEL,
};

async function configure(n: Api): Promise<void> {
  if (configured) return;
  configured = true;
  n.setNotificationHandler({
    handleNotification: async (note) => {
      const data = note?.request?.content?.data as { channel?: unknown } | undefined;
      // The in-app alarm banner is the SOS's banner while the app is open.
      const hideBanner = inAppAlarm && data?.channel === 'sos';
      return {
        shouldShowBanner: !hideBanner,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      };
    },
  });
  if (Platform.OS === 'android') {
    await n.setNotificationChannelAsync(TEAM_CHANNEL, {
      name: 'Team messages and comments',
      importance: n.AndroidImportance.HIGH,
      vibrationPattern: TEAM_VIBRATION,
    });
    await n.setNotificationChannelAsync(SOS_CHANNEL, {
      name: 'Team SOS',
      description: 'A teammate asks for help. Alarm sound and long vibration.',
      importance: n.AndroidImportance.MAX,
      sound: SOS_SOUND,
      audioAttributes: {
        usage: n.AndroidAudioUsage.ALARM,
        contentType: n.AndroidAudioContentType.SONIFICATION,
      },
      enableVibrate: true,
      vibrationPattern: SOS_VIBRATION,
      lockscreenVisibility: n.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });
    await n.setNotificationChannelAsync(RALLY_CHANNEL, {
      name: 'Team rally',
      description: 'A teammate calls everyone to a place.',
      importance: n.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: RALLY_VIBRATION,
      lockscreenVisibility: n.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

/** Ask for notification permission (once per app run); true when granted. */
export async function ensureTeamNotifications(): Promise<boolean> {
  const n = api();
  if (n === null) return false;
  try {
    await configure(n);
    const current = await n.getPermissionsAsync();
    if (current?.granted) return true;
    if (asked || current?.canAskAgain === false) return false;
    asked = true;
    const res = await n.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return res?.granted === true;
  } catch {
    return false;
  }
}

/** Raise a local notification now. Never throws. */
export async function notifyTeam(n0: {
  title: string;
  body: string;
  url: string;
  /** A `badge`-level event (#683 drawings): shown, but without a sound. */
  quiet?: boolean;
  /** Which channel (#708); the shared team channel by default. */
  channel?: AlertChannel;
  /** Replaces a notification with the same id (an SOS re-sounding), and clears by it. */
  identifier?: string | null;
}): Promise<void> {
  const n = api();
  if (n === null) return;
  const channel = n0.channel ?? 'team';
  try {
    if (!(await ensureTeamNotifications())) return;
    const sound = n0.quiet === true ? false : channel === 'sos' ? SOS_SOUND : 'default';
    await n.scheduleNotificationAsync({
      ...(n0.identifier ? { identifier: n0.identifier } : {}),
      content: {
        title: n0.title,
        body: n0.body.length > 180 ? `${n0.body.slice(0, 179)}…` : n0.body,
        data: { url: n0.url, team: true, channel },
        sound,
        ...(channel === 'sos'
          ? {
              interruptionLevel: 'timeSensitive' as const,
              priority: n.AndroidNotificationPriority.MAX,
              vibrate: SOS_VIBRATION,
            }
          : channel === 'rally'
            ? {
                priority: n.AndroidNotificationPriority.HIGH,
                vibrate: RALLY_VIBRATION,
              }
            : {}),
      },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID[channel] } : null,
    });
  } catch {
    // A refused permission or a busy scheduler: the in-app banner still shows.
  }
}

/** Clear an SOS or rally notification (resolved, ended). Never throws. */
export async function dismissTeamNotification(identifier: string): Promise<void> {
  const n = api();
  if (n === null) return;
  try {
    await n.dismissNotificationAsync(identifier);
  } catch {
    // Already gone, or never shown.
  }
}

/** The in-app SOS banner is up (its system banner then stays in the list only). */
export function setInAppAlarm(on: boolean): void {
  inAppAlarm = on;
}

/**
 * The in-app rally buzz (#743): the rally pattern, once, while the app is in
 * front (in the background the "Team rally" notification vibrates). The
 * caller gates it per raiser (`RallyBuzzGate`) and never over a sounding SOS
 * alarm, whose repeating vibration this would replace. Never throws.
 */
export function buzzRally(): void {
  if (AppState.currentState !== 'active') return;
  try {
    Vibration.vibrate(RALLY_VIBRATION);
  } catch {
    // No vibrator: the notification and the pill's "!" remain.
  }
}

/** Call `open(url)` when the user taps a team notification (also the one that launched the app). */
export function onTeamNotificationTap(open: (url: string) => void): () => void {
  const n = api();
  if (n === null) return () => undefined;
  const handle = (r: NotificationsModule.NotificationResponse | null) => {
    const data = r?.notification.request.content.data as
      { url?: unknown; team?: unknown } | undefined;
    if (data?.team === true && typeof data.url === 'string' && data.url.startsWith('/'))
      open(data.url);
  };
  void Promise.resolve()
    .then(() => n.getLastNotificationResponseAsync())
    .then(handle)
    .catch(() => undefined);
  try {
    const sub = n.addNotificationResponseReceivedListener(handle);
    return () => sub?.remove();
  } catch {
    return () => undefined;
  }
}

/** Tests: forget the lazily loaded module and the one-time setup. */
export function resetTeamNotificationsForTests(): void {
  cached = undefined;
  configured = false;
  asked = false;
  inAppAlarm = false;
}
