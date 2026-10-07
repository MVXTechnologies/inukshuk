# Inukshuk GNSS receiver transport (`InukshukGnss`)

Local Expo SDK 56 module for external GNSS receivers (#588, stage 2). It is a
**byte pipe**: connect, stream bytes to JS, write bytes to the receiver. NMEA,
UBX and RTCM framing, fixes, NTRIP and datums are pure TypeScript in
`src/core/gnss` (#617). Nothing native looks inside a byte.

| Platform | Transports                                                                     |
| -------- | ------------------------------------------------------------------------------ |
| Android  | Bluetooth Classic SPP (RFCOMM 0x1101) to bonded receivers; BLE GATT serial     |
| iOS      | BLE GATT serial (CoreBluetooth) with state restoration                         |
| Both     | `fake`: the simulated receiver (debug builds, or E2E builds with the flag set) |

## JS API

Typed in `src/lib/gnss/nativeGnss.ts` (`getNativeGnss()` returns null on
binaries without the module, so OTA JS degrades on pre-2.5.0 builds).

| Call                                                  | Notes                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `getAvailability()`                                   | `{supported, ble, classic, poweredOn, transports, fakeDevice}`; never prompts                       |
| `getPermissionsAsync()` / `requestPermissionsAsync()` | Expo `PermissionResponse`. Android 12+: Nearby devices; 8–11: precise location; iOS: Bluetooth      |
| `startScan({durationMs})` / `stopScan()`              | Unfiltered BLE scan, ≤ 60 s; results as `onDevice` (throttled to 1/s per device)                    |
| `getKnownDevices({serviceUuids})`                     | Android: bonded devices (SPP candidates). iOS: peripherals already connected with those services    |
| `connect(options)`                                    | Resolves when the attempt starts; follow `onState`. One link per process: a new connect replaces it |
| `disconnect()`                                        | Stops reconnecting; already-received bytes are still delivered                                      |
| `write(Uint8Array)`                                   | Resolves when sent (BLE: split to MTU − 3); ≤ 64 KiB queued, else `E_GNSS_WRITE_OVERFLOW`           |
| `getState()`                                          | Synchronous snapshot (after a JS reload)                                                            |

Events: `onBytes {deviceId, data (base64), length, dropped}`, `onState`
(`idle | connecting | connected | reconnecting | disconnected`, plus `mtu`,
`profile`, `writable`, `attempt`, `reason`, `retryInMs`), `onDevice`,
`onScanState`, `onRssi` (BLE, every 5 s), `onError {code, message, fatal}`,
`onAvailability`. Error codes: `GnssErrorCode` in `nativeGnss.ts`.

`src/data/gnss/receiverStream.ts` decodes `onBytes` into the core's
`GnssDemuxer` and resets it (and tells the caller, to flush the
`FixAssembler`) on every discontinuity: link lost, other device, native
overflow, corrupt chunk.

## Design decisions

- **Bytes cross as base64 in events.** Uint8Array arguments work (`write`),
  but typed arrays in event payloads are not a documented Expo contract. At
  ≤ 10 events/s of a few hundred bytes, base64 costs nothing measurable.
- **Backpressure is native.** Received bytes go into a 512 KiB ring and leave
  as at most one event per 100 ms (≤ 64 KiB each), never per byte or per
  BLE notification. With no JS listener (reload, rebuilt React host) bytes
  wait in the ring (oldest dropped and counted in `dropped`) and flush when a
  listener attaches.
- **GATT profiles are data.** Every BLE connect sends the profiles in
  priority order (`src/core/gnss/bleProfiles.ts`: Nordic UART, Microchip
  transparent UART, HM-10 FFE0). Native keeps no UUID list, so a new receiver
  family ships over the air. A device whose serial service cannot be written
  is used read-only (`writable: false`).
- **Unfiltered scans.** Many receivers do not advertise their 128-bit service;
  JS ranks results (`rankDevices`) instead.
- **Classic SPP needs pairing in Android settings.** No classic discovery or
  bonding in-app (it would need location-derived scan permissions). Secure
  RFCOMM first, insecure as a fallback for older receivers.
- **Reconnect.** Android: 1, 2, 4 … 30 s backoff, reset only after a link
  stayed up 10 s; 30 s connect timeout; immediate retry when Bluetooth turns
  back on. iOS: the first retry after a working link is a pending
  `connect` (no timeout; iOS completes it whenever the receiver is back, also
  while suspended); repeated failures back off like Android. Fatal errors
  (not bonded, no serial service, permission, unknown device) stop retrying.
- **Process-scoped link.** The session/link lives as long as the process, not
  the React instance; module instances attach as event sinks.
- **Screen off, Android.** No foreground service of our own. Recording
  already runs expo-location's `location` foreground service
  (`src/lib/backgroundLocation.ts`), which keeps the process (and the native
  socket threads) alive; Bluetooth I/O has no while-in-use restriction, so it
  needs no FGS type, and a `connectedDevice` service would need a Play FGS
  declaration for no gain. Outside a recording the app may be frozen in the
  background; the link then drops and reconnects on return. **Seam:** if the
  UI ever needs a receiver connected without recording and with the screen
  off, add a `connectedDevice` foreground service in `GnssSession`.
- **Screen off, iOS.** `bluetooth-central` delivers notifications in the
  background, and state restoration (`InukshukGnssAppDelegateSubscriber` +
  restore identifier) relaunches the app to resume the link. The central is
  never created at launch otherwise (that would prompt for Bluetooth).
- **MFi / External Accessory: not in v1.** It needs each vendor to whitelist
  the bundle id and a PPID in every App Review submission. **Seam:** a third
  transport value `ea` next to `fake` in `GnssLink.connect`, with `EASession`
  streams feeding `received(_:)`/`write`, and
  `UISupportedExternalAccessoryProtocols` per approved vendor in
  `plugins/withGnss.js`. `tcp` (Wi-Fi receivers) is reserved the same way
  (`Transport` interface on Android).
- **Simulated receiver.** `connect({transport: 'fake', fake: {frames,
intervalMs, loop}})` replays frames through the same native threads, ring
  and events. Enabled in debug builds, or in a release build built with
  `GNSS_FAKE_DEVICE=1` (manifest meta-data / Info.plist flag written by the
  plugin). Store builds reject it (`E_GNSS_FAKE_DISABLED`) and never list it.
  Recording: `src/data/gnss/fakeReceiverRecording.ts` (gpsd's Trimble
  DGPS → RTK-fixed capture, BSD-2-Clause, 10 Hz).

## Permissions and store obligations

Written by `plugins/withGnss.js` (prebuild-verified, idempotent):

| Platform | Key                                                                                       |
| -------- | ----------------------------------------------------------------------------------------- |
| Android  | `BLUETOOTH_SCAN` with `usesPermissionFlags="neverForLocation"` (`tools:targetApi="s"`)    |
| Android  | `BLUETOOTH_CONNECT`                                                                       |
| Android  | `BLUETOOTH`, `BLUETOOTH_ADMIN` with `maxSdkVersion="30"`                                  |
| Android  | `uses-feature` `android.hardware.bluetooth` and `bluetooth_le`, `required="false"`        |
| iOS      | `NSBluetoothAlwaysUsageDescription` (purpose string)                                      |
| iOS      | `UIBackgroundModes` += `bluetooth-central` (option `iosBackgroundMode: false` removes it) |

`neverForLocation` is valid: scan results are only listed for the user to
pick a receiver; positions come from the receiver's own data stream.

Owner / store actions:

- **App Store Connect: no capability change.** Neither CoreBluetooth nor the
  `bluetooth-central` background mode is an entitlement or an App ID
  capability (unlike HealthKit in 2.0.1), so no `bundleIdCapabilities` call
  and no profile regeneration.
- **App Review notes:** explain `bluetooth-central` ("receives positions from
  an external GNSS receiver over Bluetooth LE while a track records with the
  screen locked") and that a reviewer can test without hardware only through
  the phone GPS path. **If 2.5.0 ships without any UI that uses the receiver,
  set `iosBackgroundMode: false`** on the plugin entry: an unused background
  mode invites a Guideline 2.5.4 rejection.
- **App Privacy / Play data safety:** no change for this module (bytes stay
  on the device). NTRIP (later stage) sends the rover's GGA position to the
  user's chosen caster: update both forms and the privacy policy then.
- **Play Console:** no new declaration (no FGS type, no location claim for
  scanning); Bluetooth hardware stays optional, so no device is filtered out.

## Runtime fingerprint

New native code, plist and manifest keys: the fingerprint runtime changes,
so this ships only in a store build (2.5.0). OTA JS reaching older binaries
sees `getNativeGnss() === null`.

## Tests

- `android/tests/run.sh`: the pure Kotlin core (`core/`: backoff, byte ring,
  pacing, write split, scan throttle, profile choice) on a plain JVM.
- `ios/Tests/run.sh`: the same cases for `GnssCore.swift`, compiled on the host.
- Jest: `plugins/withGnss.test.ts`, `src/lib/gnss`, `src/data/gnss`,
  `src/core/gnss/bleProfiles.test.ts`.
- Both run in `native-build.yml`, which also compiles the module into the
  iOS and Android apps. Transport behaviour against real receivers needs
  hardware (an ESP32 NUS replayer, an SPP receiver): not covered in CI.
