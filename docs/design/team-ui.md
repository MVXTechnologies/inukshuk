# Team mode, stage 3: UI and app wiring (#589)

The screens and the app plumbing on top of the protocol core
(`src/core/team`, [team-protocol.md](team-protocol.md)) and the mesh
transport (`modules/inukshuk-mesh`, [team-mesh.md](team-mesh.md)). Ships in
the 2.5.0 store build.

## Layers

```
app/team/*                    routes (expo-router); each renders a screen
src/features/team/            screens, TeamHost (lifecycle), map layer + card, banner
src/state/teamStore.ts        Zustand snapshot of the service (refresh ≤ every 250 ms)
src/data/team/
  teamService.ts              device identity, team list, active team, join
  teamSession.ts              one open team: replica, actions, mesh sessions
  teamJoin.ts                 joining with an invite (search → code → confirm)
  persistingStore.ts          write-ahead persistence around the replica
  meshLink.ts                 transport start/stop, advertise, browse, dials
  teamDisk.ts / fsTeamDisk.ts op log, cursor, team index; device key in the secure store
  teamCrypto.ts               noble on expo-crypto's CSPRNG (optional native module)
  simulatedTeammates.ts       loopback builds only: simulated phones
src/core/teamui/              pure view logic (tested): roster, roles, groups,
                              chat, alerts, positions, shares, invites, lifetime
```

## Durability (spec §12b)

- Every op this device signs is appended to `teams/<id>/ops.jsonl` **before**
  it is sent, then the writer cursor is saved (`PersistingStore.track`). That
  covers ops signed inside a sync step too (an `m.admit` for a joiner, an
  admin's automatic `k.rotate`): the wrapper persists them synchronously before
  the session returns its frames.
- On launch the writer resumes from the **later** of the saved cursor and the
  device's own chain in the log, so a crash between the two writes never
  reuses a seq (tested: "restarts from disk without forking its chain").
- Team keys are never stored: they are unwrapped again from the log with the
  device's X25519 secret, which lives in the secure store
  (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`). A device restored from a backup
  without its keychain therefore cannot read its old teams; it rejoins.

## Decisions (agent, 2026-10-07; owner to confirm)

| #   | Question                                                              | Decision                                                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Display names: `m.admit` carries none and guests can't write entities | A `sys:profile` **message** (every role may post), newest per author wins; `sys:` threads never show in the chat or notify. No protocol change.                                                                                                                                                                                                                  |
| 2   | Team name after a rotation (genesis labels are under key 0)           | Admins re-post it as `sys:team` under each new key; members re-post their profile likewise.                                                                                                                                                                                                                                                                      |
| 3   | Leaving (the protocol has no self-removal)                            | "Leave team" posts `sys:leave`, stops the mesh and deletes the team from the phone. Admins see "X left — Remove" (removal rotates the key). The organizer can leave (the team continues) or end it for everyone (`t.close`).                                                                                                                                     |
| 4   | Position sharing                                                      | Off by default; per team; interval 30 s / 1 min / 5 min; **only while recording** by default (owner B9), switchable to "while the app is open". Fixes come from the recorder while recording (no second GPS client). Positions expire after 6 h.                                                                                                                 |
| 5   | Mesh lifetime                                                         | Foreground: on. Background: only while a recording runs (App Review 2.5.4, team-mesh.md). Never during a join.                                                                                                                                                                                                                                                   |
| 6   | One team at a time                                                    | Several teams can live on a phone; only the open one syncs.                                                                                                                                                                                                                                                                                                      |
| 7   | Notifications                                                         | In-app only in v1: a banner over any screen plus a buzz for `alert` (urgent, mentions, important from an admin); `badge` counts as unread. The core's routing decides, so chatter in a team of more than 30 never buzzes. System notifications while backgrounded would need `expo-notifications` (and the `aps-environment` entitlement); left for a follow-up. |
| 8   | Urgent messages                                                       | Offered to admins only (the core also lets group leads send urgent to their subtree; simpler to explain this way).                                                                                                                                                                                                                                               |
| 9   | Targeted messages                                                     | One channel; each message can go to everyone, admins, a group (subtree), a group's leads, or all leads. Messages you're not in the audience of are hidden (they still pass through, encrypted). `@Name` mentions buzz. DMs (sealed) are not in v1's UI.                                                                                                          |
| 10  | Groups                                                                | Admins create a tree of groups; v1's UI puts a member in one group (lead or not); the protocol allows 16.                                                                                                                                                                                                                                                        |
| 11  | Shares                                                                | Waypoints (shared records) and trails (owned, simplified and polyline-encoded to fit one 32 KiB op; ~1 m precision). Photos are not shared in v1 (the core supports their metadata; blobs are stage 3).                                                                                                                                                          |
| 12  | Invites                                                               | Admins only; defaults 48 h, single use, member, any member may admit. The QR also carries this phone's LAN address and port (QR only). SMS and links carry the web link `https://inukshuk.mvxtechnologies.com/j#…`; the page (`docs/j/index.html`) hands the fragment to `inukshuk://team/join?t=…` without sending it anywhere.                                 |
| 13  | Joining twice (QR hint + discovery)                                   | The joiner dials discovered phones one at a time; the admitting phone never deduplicates a joiner's connections.                                                                                                                                                                                                                                                 |
| 14  | Duplicate links between members                                       | Both phones keep the link the lower member id initiated, else the oldest.                                                                                                                                                                                                                                                                                        |
| 15  | QR scanning                                                           | `expo-camera` (the camera purpose string now mentions QR codes); its config plugin is left out so no microphone string or `RECORD_AUDIO` is added.                                                                                                                                                                                                               |
| 16  | Randomness                                                            | `expo-crypto` `getRandomValues` (spec §4.3), loaded optionally; a binary without it hides team mode instead of using a weak source.                                                                                                                                                                                                                              |
| 17  | Removing the extension                                                | Stops team mode; the teams stay on the phone until left.                                                                                                                                                                                                                                                                                                         |
| 18  | Settings layout                                                       | A compact body (team row, Create, Join, privacy line); everything else on its own screens, ready for the compact Extensions list (ui/extensions-compact).                                                                                                                                                                                                        |

## Native dependencies (2.5.0 store build)

`expo-camera ~56.0.8` and `expo-crypto ~56.0.5` (plus `expo-secure-store` from
#623 and the mesh module from #621) change the runtime fingerprint; `toqr`
0.1.1 (QR encoding, pure JS, already in the tree through the Expo CLI) does
not. `VIBRATE` is added to the Android manifest (normal permission).

Fingerprints at this PR (CI "Native runtime vs store builds", 2026-10-07): iOS
`b21b57c714d5d9b66f92703365b5b6c41b17439f`, Android
`8a04e3fc3c8ca822eda042f50cea95f1d49810ac` (store 2.3.0: iOS `f81e7412…`,
Android `884f71ce…`). Changed sources: the autolinking config, the Expo config,
`modules/inukshuk-mesh`, `expo-camera`, `expo-crypto`, `expo-secure-store`,
`plugins/withTeamMesh.js`. A store build is required.

## Privacy and store texts (owner)

- **App Store privacy (App Privacy):** no change for data _collected by us_:
  team data goes phone to phone, end-to-end encrypted, and never reaches an
  Inukshuk server. Apple's definition of "collect" is transmitting off the
  device in a way the developer or partners can access; peer-to-peer between
  users' devices without our access is not collection. Keep "Data Not
  Collected" for Location, Contacts and User Content, but mention team sharing
  in the description below.
- **App Store description / What's New:** "Team mode: share your position,
  waypoints, trails and messages with your team, phone to phone over Wi-Fi or
  a hotspot — no server, end-to-end encrypted. Your position is shared only
  while you turn sharing on."
- **Purpose strings:** Local Network (from #621, updated here to mention
  positions); camera now "…and to scan team invite QR codes".
- **Play Data safety:** "Data shared" covers transfer to third parties. Peer
  transfer the user initiates to people they chose, end-to-end encrypted, is
  not "sharing" under Play's definition (user-initiated transfer), and nothing
  is "collected" by us. Answer unchanged; if the reviewer asks, cite:
  "Precise location and messages are transferred only directly between the
  user's team members' devices, at the user's request, end-to-end encrypted;
  the developer never receives them."
- **Privacy policy (docs/privacy):** add a "Team mode" section: what is shared
  (display name, position while sharing is on, messages, shared waypoints and
  trails), with whom (members of a team you joined, directly between phones on
  the same network), how (end-to-end encrypted; nothing on our servers), how
  long (on members' phones; teams end after 14 days unless extended; removing
  a member stops new data reaching them but not what they already received;
  leaving deletes the team from your phone), and that invite links carry a
  one-time secret that our website never receives (it stays after the `#`).
- **Phone numbers:** the app never reads contacts; an SMS invite opens the
  user's own messaging app.

## Needs a real two-phone test (iPhone + Android)

On a home Wi-Fi, then on the iPhone's hotspot, then on the Android's hotspot:

1. iOS Local Network prompt on first use; deny it once and check the banner
   and the Settings link; allow and check discovery.
2. Create on one phone, invite by QR (scan with the other), compare the codes.
3. Invite by SMS: the link opens the web page, "Open in Inukshuk" opens the
   Join screen with the invite.
4. Discovery on each network; when it fails (hotspot isolation), the QR's
   address hint and "Connect by address" with the shown address.
5. Messages both ways; an urgent one buzzes; a mention buzzes.
6. Position sharing while recording with the screen off (iPhone: location
   background mode keeps the mesh; Android: the recording's foreground service;
   One UI Doze unverified); stops when sharing is off; stale positions fade.
7. Remove the second phone: it stops receiving; the key rotates; it can't
   read new messages.
8. Background without recording: the mesh stops; returning resyncs.
9. Dark mode on the Samsung (One UI 8).
