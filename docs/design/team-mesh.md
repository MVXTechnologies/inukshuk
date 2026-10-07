# Team mesh transport (#589, stage 2)

The native transport for serverless team mode: phones on the same Wi-Fi or
phone hotspot find each other and exchange **opaque frames**. Identity,
crypto, validation and sync stay in the pure core (`src/core/team`,
`docs/design/team-protocol.md`). This layer only moves bytes, and refuses
to let any peer make it spend unbounded memory, CPU or bridge traffic.

```
 src/core/team  SyncSession  (handshake · AEAD · have/want · PeerGuard)
        ▲ Step { send, events }
 src/data/team  MeshSessionHost  ── one session per connection
        ▲ MeshTransport (meshTransport.ts)
        ├── NativeMeshTransport (meshNative.ts) ── modules/inukshuk-mesh
        └── LoopbackMeshTransport (loopbackMesh.ts) ── dev / E2E only
```

Status: built and host-tested; wired to the team UI in stage 3 ([team-ui.md](team-ui.md)).

## Files

| Path                                                 | What                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `modules/inukshuk-mesh/android/.../MeshProtocol.kt`  | Pure: framing decoder, debt buckets, bans, accept rate, backoff, config clamps, tags |
| `modules/inukshuk-mesh/android/.../MeshEngine.kt`    | Pure JVM NIO engine: listener, dials, queues, throttling, timers                     |
| `modules/inukshuk-mesh/android/.../MeshDiscovery.kt` | NsdManager advertise / browse / resolve queue, multicast lock                        |
| `modules/inukshuk-mesh/android/.../MeshNetwork.kt`   | Interfaces, Wi-Fi gateways, binding LAN dials to the Wi-Fi network                   |
| `modules/inukshuk-mesh/ios/MeshProtocol.swift`       | Line-for-line mirror of `MeshProtocol.kt`                                            |
| `modules/inukshuk-mesh/ios/MeshEngine.swift`         | Network.framework engine: NWListener (+ Bonjour advert), NWBrowser, NWConnections    |
| `modules/inukshuk-mesh/ios/MeshInterfaces.swift`     | getifaddrs IPv4 interfaces                                                           |
| `modules/inukshuk-mesh/*/InukshukMeshModule.*`       | Expo glue                                                                            |
| `plugins/withTeamMesh.js`                            | Info.plist keys, Android permissions                                                 |
| `src/core/mesh/{tag,hotspot}.ts`                     | Discovery tag, hotspot dial candidates (pure)                                        |
| `src/data/team/*`                                    | Transport contract, native adapter, loopback hub, session host                       |

## Wire

Each side sends an 8-byte preamble once, then frames:

```
preamble  49 4E 4B 4D  01  00 00 00     "INKM", version 1, 3 reserved bytes
frame     u32 big-endian length L, then L payload bytes
          L == 0 is a keepalive (never delivered to JS)
```

- The preamble makes HTTP probes, port scanners and wrong protocols fail on
  their **first byte**. A different version byte closes the connection
  without a strike (a newer app is not an attacker).
- `L` is unsigned and checked against the frame cap **before** anything is
  allocated. The body buffer starts at 4 KiB and doubles only as bytes
  actually arrive, never past `L`: a peer announcing 1 MiB and sending 10
  bytes costs 4 KiB. Fuzz tests on both platforms assert
  `peakAllocation ≤ max(4 KiB, 2 × bytes received)` and `≤ cap` over random
  garbage and random chunking, and exact reassembly of valid streams.
- No TLS here: the core seals every frame after its own handshake
  (XChaCha20-Poly1305, counter nonces). An observer on the Wi-Fi sees sizes
  and timing only.

## Limits (defaults; JS may lower or raise within hard bounds)

| Limit                                 | Default                                   | Bounds                    | Why                                                               |
| ------------------------------------- | ----------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| Frame cap                             | 512 KiB                                   | 1 KiB – 1 MiB             | = core `LAN_LIMITS.maxFrameBytes`; 1 MiB ceiling is compiled in   |
| Peers (all connections)               | 16                                        | 1 – 64                    | Teams of 100+ (owner B4) gossip over a partial mesh, not a clique |
| Inbound per IP                        | 2                                         | 1 – 4                     | Room for a reconnect overlapping a dying socket                   |
| Pending (pre-preamble) inbound        | 8                                         | 1 – 32                    | Slowloris                                                         |
| Accepts per IP per minute             | 20                                        | 1 – 120                   | Connection floods; over the rate is a strike                      |
| Read rate                             | 8 MiB/s, 400 frames/s per peer (burst ×2) |                           | Outer wall, 2× the core's `PeerGuard`                             |
| Send queue per peer                   | 4 MiB                                     | ≥ 2 frames                | Backpressure threshold                                            |
| Inbox (received, not yet taken by JS) | 2 MiB per peer, 16 MiB total              |                           | Bridge protection                                                 |
| Keepalive / idle timeout              | 15 s / 45 s                               | idle ≥ 2 keepalives + 1 s | Dead peers on a dropped hotspot                                   |
| Preamble timeout                      | 5 s                                       | 1 – 60 s                  | Silent sockets                                                    |
| Connect timeout                       | 10 s                                      | 1 – 60 s                  |                                                                   |
| Ban (strikes)                         | 3 strikes / 10 min → 10 min               | ban ≤ 24 h                | Bounded tables (256 addresses)                                    |

**Rate caps throttle, they do not ban.** Bytes and frames (keepalives
included) are charged to a token bucket that may go into debt; while in
debt the engine stops reading that socket. An honest fast sender just slows
down (TCP flow control); a flood costs us nothing because we stop reading
it. Likewise, when JS does not take frames fast enough, reading pauses
(per peer, and globally). Nothing queues without bound anywhere.

**Bans** come from two places: transport violations (bad magic, oversize
length, silent socket, accept-rate abuse: three strikes in 10 min ban the
address for 10 min), and the core (`SyncSession.bannedUntil`, set by
`PeerGuard` after 20 strikes/min: oversize or over-rate frames, bad
signatures, undecryptable frames, malformed ops including `chain` rejections,
protocol violations). `MeshSessionHost` turns the latter into
`transport.ban(peerId, ms)`. A banned address is refused at `accept`, not
dialled, and hidden from discovery. Bans are by IP: on a LAN that is a phone;
the 24 h cap bounds the damage if DHCP later gives that address to someone
else.

## Discovery

- Service type `_inukshuk-team._tcp`; instance name `ink-` + 12 random
  base32 characters, new each time advertising starts. **No device, user,
  team or member name ever goes on the air.**
- TXT: `v=1`, `t=<tag>`. The tag is `base64url(SHA-256("inukshuk/team/v1/lan-tag" ‖ teamId))[0..16 bytes]`
  (`lanDiscoveryTag(teamId, teamCrypto)`, `src/core/mesh/tag.ts`, hashed with the
  core's own SHA-256): enough for teammates and invite holders to find
  the team, nothing for a stranger beyond "an Inukshuk team is here".
- Android resolves each service before reporting it (TXT is only available
  after resolve). Resolves are serialized (NsdManager before API 34 allows
  one at a time) in a queue capped at 64; the service table is capped at 256. A Wi-Fi multicast lock is held while advertising or browsing.
- iOS reports services from NWBrowser results (TXT included) without host or
  port: `connectService(serviceId)` lets Network.framework resolve. Own
  adverts are filtered by name on both platforms.

## Hotspot and manual join

Owner B3: mixed iPhone + Android from day 1, so plain TCP over the LAN.

- Every phone listens on **47321** first (any free port if taken). A phone
  joined to a hotspot reaches the hotspot phone at its gateway:
  `hotspotCandidates(networkInfo())` returns Android's real Wi-Fi gateway
  first, then each private subnet's `.1` (iOS has no gateway API; an iPhone
  Personal Hotspot is 172.20.10.1, Android hotspots hand out their `.1`).
  `looksLikeHotspotHost` tells the hotspot phone it should wait, not dial.
- When mDNS is blocked (client isolation, corporate Wi-Fi, hotspots that
  drop multicast), `connect(host, port, { reconnect: true })` with the
  invite's network hint (`NetHint` in the core's invite) or a typed
  IP:port.
- Android: when Wi-Fi has no internet, cellular stays the default network
  and a plain socket to a LAN address may not route. A dial to an address
  inside a Wi-Fi network's subnet is bound to that network first
  (`Network.bindSocket`). iOS: cellular is a prohibited interface for every
  mesh socket, so team frames never leave over mobile data.
- Reconnect: exponential backoff 1 s → 60 s, ±20 % jitter, reset after a
  connection stayed up 30 s; unlimited until `disconnect(dialId)`. A dial
  closed by a ban or a protocol violation does not retry.

Not in this stage: starting a hotspot from the app (Android
`LocalOnlyHotspot` needs `NEARBY_WIFI_DEVICES` and location on older
versions; iOS `NEHotspotConfiguration` needs the Hotspot Configuration
entitlement). Users turn on their phone's hotspot themselves.

## JS API

`selectMeshTransport()` (`src/data/team`) returns the native transport, the
loopback one under `EXPO_PUBLIC_MESH_LOOPBACK=1`, or null on binaries
without the module.

```ts
start(config?) → Promise<{ port }>          stop() → Promise<void>
startAdvertising(tag) / stopAdvertising()    startBrowsing(tag | null) / stopBrowsing()
connect(host, port, { reconnect? }) → dialId connectService(serviceId, { reconnect? }) → dialId
disconnect(peerId | dialId)                  ban(peerId, ms)
send(peerId, bytes) → { ok: true, queuedBytes } | { ok: false, reason: 'backpressure' | 'no-peer' | 'too-large' }
stats() · state() · networkInfo() · subscribe(listener) → unsubscribe
events: peer-found · peer-lost · connected · disconnected · frame · writable · error · state · stats
```

- A **peer id names one connection**. A reconnect is a new peer id (and a
  new sync session) under the same dial id; `connected.peer.dialId`
  correlates them.
- Frames cross the bridge as `Uint8Array` (Kotlin `ByteArray` / Swift
  `Data`), pulled by JS in batches of 128 when native signals
  `onFramesAvailable` (one signal until JS drains). Frames received before a
  close are delivered before its `disconnected` event.
- `send` refused with `backpressure` was not queued; a `writable` event
  follows once the queue is below a quarter. `MeshSessionHost` holds such
  frames (≤ 8 MiB per peer, else it drops the peer rather than lose a
  frame) and flushes them on `writable`.

`MeshSessionHost(transport, factory, onEvent)` runs one core session per
connection (outbound → `SyncSession.initiate(c, store, { now, handshakeTimeoutMs })`,
inbound → `respond`; the factory gets `now`), sends
every frame of every `Step`, disconnects a session that closed, bans one
that banned, and calls `tick(now)` on every session every 10 s (re-sync when
open; the core's hi1/hi2/hi3 handshake timeout before). `forEachOpen(s => s.push(ops))`
gossips new local ops.

## Background (honest)

**iOS**

- Foreground: everything works.
- Backgrounded: iOS suspends the app a few seconds later. Sockets stop; a
  suspended app's listening socket is reclaimed. On backgrounding the module
  asks for a short background task **only while frames are still queued**
  (≤ 20 s), so a message sent just before locking the phone goes out. No new
  background mode is declared.
- While a trail recording runs, the existing `location` background mode
  keeps the app alive, so team sync keeps working with the screen off. This
  is the research's rule (TEAM.md §6): sync in the background only while
  recording, never use location as a keep-alive for networking (App Review
  2.5.4). The team UI must stop the mesh on background when not recording.
- On return to the foreground after ≥ 5 s away, the listener and the browser
  are replaced (same port, same advert, same filter) even if they claim to
  be fine: the loopback PDF server proved a reclaimed listener can still say
  "ready". Accepted connections are independent of the listener; dead ones
  end by idle timeout and reconnect by backoff.
- UIScene lifecycle (iOS 27, `plugins/withIosSceneLifecycle.js`): Expo's
  `OnAppEntersBackground` / `OnAppEntersForeground` come from the
  `UIApplication` background/foreground notifications, which UIKit still
  posts under scenes; they never depended on the app-delegate methods the
  SceneDelegate now forwards. The module also observes
  `UIScene.didEnterBackgroundNotification` / `willEnterForegroundNotification`
  and dedupes the two sources (the first one acts), so the refresh survives
  either path. `plugins/withTeamMesh.test.js` asserts the plugin order, the
  coexisting Info.plist keys, the scene delegate's forwarding and the
  module's observers.

**Android**

- Threads keep running while the process lives. Without a foreground
  service, Android may stop the process or cut its network in Doze; One UI
  is aggressive (the owner's phone). While a recording runs, its location
  foreground service keeps the process alive and the mesh with it. Whether
  Doze still restricts the sockets of a process with a location foreground
  service is **unverified on device**.
- No `connectedDevice` foreground service was added: it needs
  `FOREGROUND_SERVICE_CONNECTED_DEVICE`, a Play declaration and a demo video.
  Revisit with the UI if "team session with the screen off, not recording"
  becomes a requirement.

## Permissions and store declarations

| Platform | Added                                                                                                      | User-visible                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| iOS      | `NSLocalNetworkUsageDescription`, `NSBonjourServices: [_inukshuk-team._tcp]`                               | The Local Network prompt, the first time the app browses, advertises or dials a LAN address        |
| iOS      | **No entitlement.** Bonjour via Network.framework does not need `com.apple.developer.networking.multicast` | Nothing to enable in App Store Connect first                                                       |
| Android  | `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`                     | All normal (install-time) permissions, no prompt. `NEARBY_WIFI_DEVICES` deliberately not requested |

Denied Local Network on iOS cannot be queried; it shows up as a
`PolicyDenied` browser or listener error. The module reports
`state.localNetwork = 'denied'` and an `E_MESH_LOCAL_NETWORK_DENIED` error;
the UI should send the user to Settings › Privacy & Security › Local
Network.

Store forms (owner, when team mode ships in the UI, not for a binary that
only contains the module): the App Privacy and Play Data safety answers do
not change for the transport itself (nothing leaves the device for us; data
goes phone to phone, end-to-end encrypted). Live positions shared with
teammates (owner B9) will need a mention in the privacy policy and the
description of location use.

## Tests

- `modules/inukshuk-mesh/scripts/test-android.sh` (kotlinc, plain JVM) and
  `modules/inukshuk-mesh/ios/Tests/run.sh` (swiftc, macOS) run the same
  suites in CI (native-build.yml): wire vectors, the framing fuzz (valid
  streams under random chunking; garbage, oversized and sign-bit lengths),
  buckets, bans, backoff and config clamps; then two real engines over
  127.0.0.1: exchange of a 300 KB frame, HTTP-probe / oversize / silent
  sockets closed and the address banned, per-IP limit, keepalive and idle
  timeout, end-to-end backpressure with no frame lost, read throttling,
  reconnect onto a restarted listener on the same port, core-requested ban,
  and (iOS) the listener replacement after a suspension.
- Jest: the native adapter against a fake module, the loopback hub, the
  session host (with a stand-in session of the core's shape), tag and
  hotspot helpers, the config plugin.
- **Not yet tested on devices**: real Wi-Fi, hotspots, the iOS permission
  prompt, NsdManager on One UI, background behaviour. The UI stage's QA pass
  must cover them (two phones, one iPhone + one Android, on a home Wi-Fi and
  on each phone's hotspot).

## Decisions recorded (owner away, 2026-10-07)

1. One TCP connection per peer pair, no full mesh: `maxPeers` 16 by default;
   the gossip layer picks whom to dial (100+ teams relay).
2. Own 8-byte preamble with magic and version instead of bare length frames.
3. Rate limits throttle reads (TCP backpressure) instead of banning; bans
   are for protocol violations and core verdicts.
4. Frames pulled by JS (`takeFrames`) rather than pushed in events: binary
   in event payloads is not guaranteed by the Expo bridge, and pulling gives
   natural backpressure from JS to the socket.
5. Well-known port 47321 with fallback, so a hotspot host is reachable at
   gateway:47321 when mDNS is blocked.
6. Cellular prohibited for mesh sockets on iOS; LAN dials bound to Wi-Fi on
   Android.
7. No foreground service, no new iOS background mode, no hotspot creation in
   this stage.
8. Loopback transport selected by `EXPO_PUBLIC_MESH_LOOPBACK=1` only, which
   no store build sets.
