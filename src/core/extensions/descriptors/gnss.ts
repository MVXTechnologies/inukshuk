/**
 * External GNSS receiver (#588): a Bluetooth receiver (DIY u-blox kits,
 * Bad Elf, Garmin GLO, Emlid Reach…) as the app's position source, with RTK
 * corrections from an NTRIP caster. A free device extension (owner A7): no
 * tiles. The logic is `@core/gnss`; the app half is `@features/extensions/gnss`.
 */
import type { DeviceExtensionDescriptor } from '../types';

export const GNSS_EXTENSION: DeviceExtensionDescriptor = {
  label: 'External GNSS receiver',
  teaser: 'a GNSS receiver',
  // Installed = in use: its switch is "Use the receiver".
  defaults: { show: true, offline: false },
};
