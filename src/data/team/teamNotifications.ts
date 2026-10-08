/**
 * System notifications for team mode (#589): LOCAL notifications raised by
 * team ops this phone received over the LAN or hotspot — no push server,
 * no remote token, no `aps-environment` entitlement (expo-notifications'
 * config plugin is left out on purpose: it only configures push).
 *
 * - Only `alert`-level team events notify (the core's routing: urgent,
 *   mentions, important from an admin, a comment on my trail or photo).
 *   Chatter in a team of more than 30 never does.
 * - Shown in the foreground too (a banner over the app), so a comment that
 *   lands while the map is open is seen.
 * - The permission is asked the first time it is needed, once.
 * - Tapping one opens the route it carries (`data.url`).
 *
 * Loaded lazily and optionally: a binary without the module (an OTA onto a
 * pre-2.5.0 build) simply never shows system notifications.
 */
import { requireOptionalNativeModule } from 'expo';
import type * as NotificationsModule from 'expo-notifications';
import { Platform } from 'react-native';

type Api = typeof NotificationsModule;

let cached: Api | null | undefined;
let configured = false;
let asked = false;

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

async function configure(n: Api): Promise<void> {
  if (configured) return;
  configured = true;
  n.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await n.setNotificationChannelAsync(TEAM_CHANNEL, {
      name: 'Team messages and comments',
      importance: n.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
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
export async function notifyTeam(n0: { title: string; body: string; url: string }): Promise<void> {
  const n = api();
  if (n === null) return;
  try {
    if (!(await ensureTeamNotifications())) return;
    await n.scheduleNotificationAsync({
      content: {
        title: n0.title,
        body: n0.body.length > 180 ? `${n0.body.slice(0, 179)}…` : n0.body,
        data: { url: n0.url, team: true },
        sound: 'default',
      },
      trigger: Platform.OS === 'android' ? { channelId: TEAM_CHANNEL } : null,
    });
  } catch {
    // A refused permission or a busy scheduler: the in-app banner still shows.
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
