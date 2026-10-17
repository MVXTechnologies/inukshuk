/**
 * Team mode (#589): a serverless team on the phones themselves — members,
 * roles and groups, invites by SMS, link or QR, live positions, messages and
 * shared waypoints and trails, end-to-end encrypted, nearby (same Wi-Fi or
 * hotspot) or over the internet (2.7.0). A free device extension (owner B11): no tiles. The
 * protocol is `@core/team`; the app half is `@features/team`.
 */
import type { DeviceExtensionDescriptor } from '../types';

export const TEAM_EXTENSION: DeviceExtensionDescriptor = {
  label: 'Team mode',
  teaser: 'team mode',
  summary: 'Share with your team',
  // Installed = available; its switch is "Show teammates on the map".
  defaults: { show: true, offline: false },
};
