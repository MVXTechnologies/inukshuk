import { bytesToBase64 } from '@core/encoding/base64';
import { asciiToBytes } from '@core/gnss/bytes';
import type { GnssConnectOptions } from '@lib/gnss/nativeGnss';

import { FAKE_RECEIVER_FRAMES, FAKE_RECEIVER_INTERVAL_MS } from './fakeReceiverRecording';

/**
 * The simulated receiver: a native test transport that replays a recorded
 * NMEA session through the same native threads, buffering and events as a
 * real Bluetooth link, so Maestro can drive the receiver UI without
 * hardware.
 *
 * Availability is decided natively, never here: debug builds always; a
 * release build only when built with GNSS_FAKE_DEVICE=1 (E2E), which
 * plugins/withGnss.js turns into a manifest / Info.plist flag. Store builds
 * reject `connect` with E_GNSS_FAKE_DISABLED and never list the device.
 * Check `getAvailability().fakeDevice` before offering it.
 */

/** Must match FAKE_DEVICE_ID in GnssSession.kt / GnssLink.swift. */
export const FAKE_RECEIVER_ID = 'inukshuk-fake-receiver';

const asciiBase64 = (text: string) => bytesToBase64(asciiToBytes(text));

let frames: string[] | null = null;

/** Connect options for the simulated receiver (frames encoded once). */
export function fakeReceiverConnectOptions(loop = true): GnssConnectOptions {
  frames ??= FAKE_RECEIVER_FRAMES.map(asciiBase64);
  return {
    deviceId: FAKE_RECEIVER_ID,
    transport: 'fake',
    autoReconnect: false,
    fake: { frames, intervalMs: FAKE_RECEIVER_INTERVAL_MS, loop },
  };
}
