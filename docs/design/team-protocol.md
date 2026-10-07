# Team protocol v1 (serverless team mode, #589)

Stage 1: the pure protocol core in `src/core/team/`. Read this before you
touch team code, the mesh transport (`modules/inukshuk-mesh`), the Nostr
transport, or the paid hosted relay (#590).

**Status (2026-10-07):** stage 1 is merged as pure TypeScript with tests.
Nothing is wired: there is no transport, no persistence, no UI and no crypto
library yet. Research and owner decisions are in
`~/Documents/inukshuk-saved/research-gnss-team/` (`TEAM.md`,
`OWNER-ANSWERS-2026-10-06.md`) and on #589.

## 1. What is built and what is not

| In stage 1 (`src/core/team/`)                                         | Later                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------- |
| Crypto interface + test double (`crypto.ts`, `testing/nodeCrypto.ts`) | The noble-based implementation (needs a dependency, §4.3) |
| Identities, team ids, op ids (`ids.ts`)                               | Key storage in `expo-secure-store` (`src/data/team`)      |
| Signed, encrypted op envelope (`envelope.ts`)                         | Blob transfer: photos, track files (§11.3)                |
| Membership log and its validation (`membership.ts`)                   | `modules/inukshuk-mesh`: LAN/hotspot TCP, mDNS (§12)      |
| Team-key epochs, wraps, rotation (`keys.ts`, `actions.ts`)            | Nostr relay transport (§13)                               |
| Invites for SMS, link and QR (`invite.ts`)                            | UI, notifications, map layer                              |
| CRDTs and the data view (`crdt.ts`, `data.ts`, `photos.ts`)           | Compaction and snapshots                                  |
| Notification routing (`notify.ts`)                                    |                                                           |
| Op log and version vectors (`log.ts`), replica (`replica.ts`)         |                                                           |
| Sync session state machine, rate limits (`sync.ts`, `ratelimit.ts`)   |                                                           |

Every module is pure: no React Native, Expo, timers, sockets or clocks.
`now` and the crypto implementation are passed in. Everything that reads
peer input is **total**: hostile bytes give a rejection value and never throw.
The fuzz tests check this.

## 2. How this relates to existing code

- **Sync M0 (`src/core/sync`, unwired).** It is single-user LWW over wall-clock
  stamps. The team protocol keeps M0's rules and moves them to an HLC:
  - newer wins;
  - a tombstone wins an exact tie;
  - a newer edit resurrects a deleted record;
  - the future-skew bound is `MAX_FUTURE_SKEW_MS`, imported from
    `@core/sync/clock`.

  M0 clamps far-future stamps. The team protocol cannot clamp, because stamps
  are signed, so it rejects them instead (`hlc.ts`). M0's `planMerge` works on
  whole items for a server-backed transport. Team data merges per field
  (`crdt.ts`), so two people editing different fields of one waypoint both
  keep their change. The two engines stay separate: M0 is "my devices via my
  NAS/account", team mode is "many people's phones". Later, #590 can carry a
  user's own team data into their personal sync.

- **Photos model (`src/core/photos/model.ts`, #587).** It was designed for this.
  `photos.ts` maps a `TrackPhoto` to an owned `photo` entity and back through
  the model's own `sanitizePhoto`, so a team photo obeys exactly the sidecar
  rules:
  - `createdAt`/`updatedAt` come from the oldest and newest HLC writes;
  - `deletedAt` comes from the tombstone;
  - `author` is the owner's member id plus display name;
  - `contentHash` is synced;
  - device-local paths and `sourceKey` are never synced.

  `PhotoComment` maps to an owned `comment` entity the same way.

## 3. Architecture in one picture

```
 transport (mesh TCP | Nostr | #590 relay)      ← moves opaque frames, in order
        │ bytes
 SyncSession  (sync.ts)  handshake · AEAD frames · have/want · PeerGuard limits
        │ envelopes
 TeamReplica  (replica.ts)  checkEnvelope → OpLog → resolveTeam → keyring → reduceData
        │                              │                │
   OpLog (log.ts)        TeamState (membership.ts)   TeamData (data.ts → crdt.ts)
                                                        │
                                       notify.ts (who is alerted) · photos.ts (model bridge)
```

## 4. Identity and crypto

### 4.1 Primitives

| Use                                         | Primitive                                                |
| ------------------------------------------- | -------------------------------------------------------- |
| Signatures (ops, handshake, join proofs)    | Ed25519 (RFC 8032), strict verification (canonical `S`)  |
| Key agreement (wraps, sealed ops, sessions) | X25519 (RFC 7748); all-zero shared secrets are refused   |
| Encryption                                  | XChaCha20-Poly1305: 24-byte nonce, 16-byte tag           |
| KDF                                         | HKDF-SHA256 (RFC 5869), labels `inukshuk/team/v1/<name>` |
| Hashes and ids                              | SHA-256; HMAC-SHA256 for handshake identity MACs         |

Every signature, hash and KDF input starts with a domain label, so a value
from one context is never valid in another.

### 4.2 Device and member

- Each device generates one Ed25519 key and one X25519 key on first team use
  (`generateDeviceKeys`). The secrets live in the secure store.
- **memberId = the Ed25519 public key** (base64url, 43 characters). Any peer
  verifies an op from its author field alone.
- A person with two phones counts as two members in v1.
- The phone number is never an identity (owner B7). It stays on the inviting
  device as a contact label.

### 4.3 Library recommendation (dependency not added — owner/lead to approve)

`@noble/curves` (ed25519, x25519), `@noble/hashes` (sha256, hmac, hkdf) and
`@noble/ciphers` (xchacha20poly1305):

- They are pure JavaScript and safe on Hermes, with no native module and
  no store release.
- They are synchronous, which suits the `TeamCrypto` interface.
- They have been audited: Cure53 (2024) and Trail of Bits (2023; 2026 for
  curves).
- Use `ed25519.verify(sig, msg, pub, { zip215: false })` (strict RFC 8032).
- Random bytes come from `expo-crypto` `getRandomBytes` or noble's `randomBytes`
  with the `crypto.getRandomValues` polyfill.
- `expo-crypto` alone is not enough: it has no Ed25519 or X25519.
- Speed upgrade if profiling asks for it: `react-native-quick-crypto` (JSI).

The test double (`testing/nodeCrypto.ts`) is Node's OpenSSL plus a pure-JS
HChaCha20. `nodeCrypto.test.ts` pins it to the RFC 8032, RFC 7748, RFC 5869
and draft-irtf-cfrg-xchacha vectors. A noble implementation must pass the
same file.

## 5. Wire format

### 5.1 Encoding

- **Canonical JSON** (`canonical.ts`) is the RFC 8785 (JCS) subset:
  - keys sorted by UTF-16 code units, no whitespace;
  - ECMAScript number formatting, `-0` written as `0`;
  - only finite numbers; depth ≤ 16;
  - `undefined` members omitted.
- Binary values are unpadded base64url with canonical trailing bits, so each
  value has exactly one text form.
- Unknown members are rejected everywhere, so an op has exactly one valid
  encoding.

### 5.2 Envelope (`envelope.ts`) — **frozen for v1**

```
{ v:1, tm, au, sq, hc:[wallMs,counter], t,
  b?, aud?, pr?, ttl?, k? | x?:{e, w:[[memberId, wrappedCek]…]}, n?, c?, sg }
```

| Field    | Meaning                                                                             |
| -------- | ----------------------------------------------------------------------------------- |
| `v`      | Protocol version (1)                                                                |
| `tm`     | teamId: 16 bytes of `SHA-256(label ‖ ownerPub ‖ genesisNonce)`                      |
| `au`     | Author memberId                                                                     |
| `sq`     | Per-author sequence: 1, 2, 3… for logged ops, 0 for ephemeral ops                   |
| `hc`     | HLC `[wall ms ≥ 2020, counter ≤ 65535]`                                             |
| `t`      | Op type (§5.3)                                                                      |
| `b`      | Control body, **in clear** (authority data every peer must check)                   |
| `aud`    | Audience (§9), canonical form only                                                  |
| `pr`     | Priority: 1 important, 2 urgent (`msg` only)                                        |
| `ttl`    | Seconds, 1–86400, ephemeral ops only                                                |
| `k`      | Group-mode key id (12-byte hash of the epoch key)                                   |
| `x`      | Sealed mode: ephemeral X25519 key plus the content key wrapped per recipient (≤ 64) |
| `n`, `c` | Nonce and ciphertext of the canonical-JSON body (data ops) or labels (control ops)  |
| `sg`     | Ed25519 over `"inukshuk/team/v1/op\n" ‖ canonical(envelope − sg)`                   |

- **opId** = SHA-256 of those signing bytes. It is the dedupe id.
- **AEAD associated data** = `"…/aad\n" ‖ canonical(envelope − sg − c)`, so a
  ciphertext cannot be moved under another header.

Stateless admission (`checkEnvelope`) checks, in order:

1. shape;
2. version;
3. team;
4. author;
5. seq;
6. HLC;
7. skew (≤ 24 h ahead of the receiver's clock);
8. per-type field rules;
9. per-type byte cap;
10. signature.

### 5.3 Op types

| Type                    | Class     | Who                                                | Body                                                                 |
| ----------------------- | --------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `m.genesis`             | control   | creator (becomes owner)                            | `{nonce, x, exp, kw}`, where `kw` wraps key 0 for the owner          |
| `m.add`                 | control   | admin+                                             | `{m, x, r, g?, from?, kw}`                                           |
| `m.admit`               | control   | member+ (an admin if the invite says `ap:'admin'`) | `{m, x, inv, ip, js, kw}` (join proof + key wrap)                    |
| `m.update`              | control   | admin+                                             | `{m, r?, g?, cut?, from?}`; `cut` is required when demoting an admin |
| `m.remove`              | control   | admin+                                             | `{m, cut}`                                                           |
| `i.create` / `i.revoke` | control   | admin+                                             | `{inv, exp, max, r, g?, ap}` / `{inv}`                               |
| `g.set` / `g.del`       | control   | admin+                                             | `{id, p?}` / `{id}`                                                  |
| `t.extend` / `t.close`  | control   | admin+                                             | `{exp}` / `{}`                                                       |
| `k.rotate`              | control   | admin+                                             | `{kw}` with exactly one new key                                      |
| `k.share`               | control   | any member holding the key                         | `{kw}` re-wrapping existing keys for active members                  |
| `e.set` / `e.del`       | data      | member+                                            | `{k:kind, id, f:{field:value}}` / `{k, id, o?}`                      |
| `msg`                   | data      | guest+                                             | `{id, th, tx ≤ 4000, mn?}`                                           |
| `pos`                   | ephemeral | guest+                                             | `{la, lo, ac?, el?, at}`                                             |

Byte caps:

| Ops         | Cap                                           |
| ----------- | --------------------------------------------- |
| Control ops | 128 KiB (a rotation for 500 members ≈ 60 KiB) |
| `e.set`     | 32 KiB                                        |
| `msg`       | 16 KiB                                        |
| `e.del`     | 2 KiB                                         |
| `pos`       | 1 KiB                                         |

### 5.4 Versioning

- `v` is the envelope version. A peer refuses a version it doesn't know. It
  does not try to half-read it, mirroring the photo sidecar's `future` status.
- New op types or body fields need a new `v`: unknown types and members are
  refused by design, because otherwise two peers could disagree on validity.
  A v2 peer must keep reading v1 ops.
- The protocol version is also negotiated in the handshake (`hi1.v`).
- **Frozen now for #590 compatibility:**
  - the envelope v1;
  - canonical JSON;
  - the signing, AAD and op-id derivations;
  - the version-vector handshake;
  - the invite token v1;
  - the teamId derivation.

## 6. Membership log (`membership.ts`)

- **One total order.** Every peer folds the op set in the order
  `(hlc.wall, hlc.counter, author, opId)` and checks each op against the state
  at that point. The result depends only on the set of ops, never on arrival
  order. A test resolves 25 shuffled orders with duplicates to identical state.
- **Authority chain:**
  - the owner (genesis author) is never removable;
  - the owner grants and revokes admin;
  - admins manage members and guests, invites, groups, expiry and keys;
  - a member may _admit_ a joiner who proves an admin-signed invite. That is how
    "admins sign membership" works when no admin is in range: the admin signed
    the invite.
  - Invites only mint members or guests. Admins are always granted by hand.
- **Concurrent admin actions** resolve last-writer-wins in the total order, and
  an op whose target is already gone is invalid. So a removal beats a
  concurrent role change in either order (tested both ways).
- **Concurrent use of a single-use invite:** the first admission in the total
  order wins everywhere, and the other joiner is told "already used".
- **Backdating defence (cuts).** HLCs are chosen by the author, so a removed
  or demoted member could sign ops with old timestamps.
  - `m.remove` and admin demotions carry `cut`: the target's last seq that the
    remover had seen.
  - The target's ops with `sq > cut` are rejected (removal) or lose admin
    authority (demotion), wherever their HLC sorts.
  - Work the target did that the remover had not yet received is lost. That is
    the price of determinism without a server.
  - Removal cuts are enforced in a second pass. Admin cuts can only come from
    the always-authoritative owner, so they are collected up front.
  - A demoted admin cannot be re-promoted in v1.
  - A removed device cannot be re-added; it rejoins with a new key.
- **Expiry and closing:**
  - `exp` defaults to genesis + 14 days (owner B6) and is capped at genesis +
    365 days.
  - `t.extend` only ever raises it. It is valid even after expiry, which
    revives the team.
  - Ops stamped after the expiry in force at their position are refused.
    `t.close` freezes the team.
  - Read-only UI: `isReadOnly(state, now)`.
- **Limits:**
  - 500 active members;
  - 256 groups, at most 8 levels deep;
  - 16 groups per member;
  - invites: ≤ 30 days, ≤ 1000 uses.

## 7. Keys (`keys.ts`)

- **Scheme:**
  - One symmetric **team key per epoch**.
  - Each epoch key is delivered as _wraps_ inside admin-signed ops:
    `m.genesis`, `m.add`/`m.admit` (for the joiner), `k.rotate` (for every
    active member) and `k.share` (for someone who missed one).
  - A wrap: `kek = HKDF(X25519(ephemeral, memberX), salt = teamId, "wrap" ‖ e ‖
memberId|keyId)`, then the key is sealed under `kek` with a zero nonce.
    Each `kek` is used exactly once. One ephemeral key serves all wraps of an
    op.
  - A recipient checks that the unwrapped key hashes to its claimed `keyId`.
- **Removal ⇒ rotation, fail closed.**
  - A key that reached a now-removed member is unsafe, so `sendKeyId` becomes
    undefined and `needsRotation` true.
  - Group-mode writes return `undefined` until an admin rotates.
  - Two admins racing removals and rotations end up with no safe key, and the
    team waits for a fresh rotation (tested).
  - Members missing the current key are listed (`missingKey`) so any holder can
    `k.share`.
- **Trade-offs (why not sender keys or MLS in v1):**

  |                                 | Admin epoch key (chosen)                                | Signal sender keys                                                   | MLS (RFC 9420)                                      |
  | ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
  | Rekey after a removal           | **one op, O(n)** wraps                                  | every member re-sends pairwise: O(n²) messages, each must gossip     | O(log n) tree update                                |
  | Works when senders are offline  | **yes**: the joiner gets everything from any peer's log | no: you cannot read a sender who hasn't been online since you joined | yes, but needs ordered commits (a delivery service) |
  | Forward secrecy inside an epoch | none                                                    | yes (hash ratchet)                                                   | yes                                                 |
  | Post-compromise security        | on the next rotation                                    | on the next re-key                                                   | yes                                                 |
  | Implementation                  | ~150 lines on audited primitives                        | moderate                                                             | a native Rust module (OpenMLS)                      |

  For trail teams the dominant risk is a lost or departed phone, which removal
  plus rotation handles. MLS is the upgrade path once #590 provides the
  ordering service it wants.

- **Sealed mode** (DMs, narrow audiences ≤ 64): a fresh content key is wrapped
  to each recipient's X25519 key plus the author's. Other members store and
  relay the op but cannot read it.

## 8. Invites (`invite.ts`)

### 8.1 Token

- **Layout:** version, flags, teamId(16), **seed(16)**, expiry(4).
- **Size:** 38 bytes, i.e. 51 base64url characters.
  `https://inukshuk.mvxtechnologies.com/j#<51>` is 91 characters, one SMS
  segment.
- **Where the secret sits:** after `#`. A browser never sends the fragment to
  the server, and the Inukshuk site hosts no join endpoint.
- **QR codes only** may add a network hint:
  - an IPv4 address and port to dial;
  - the Android LocalOnlyHotspot SSID and password, for iOS
    `NEHotspotConfiguration`.
- **The `i.create` op** holds only the **invite public key** (Ed25519, derived
  from the seed with HKDF), the expiry, the use limit, the role, the groups
  and who may admit.

### 8.2 Join flow

1. The joiner scans the QR code or opens the link.
2. The joiner finds peers advertising the team on the LAN or hotspot.
3. The joiner opens a session with `join` (§10.1). The join proof is the
   invite key's signature and the joiner key's signature over
   `{tm, m, x, inv}`.
4. Any member checks the proof against its log and its own wall clock (expiry,
   uses, revocation), then writes `m.admit` with the team key wrapped for the
   joiner.
5. The joiner verifies the log it receives: the genesis must reproduce
   `teamId`, which commits to the owner key, and its peer must be an active
   member. A rogue LAN peer therefore cannot fake a team.
6. Both phones can show `safetyCode(teamId, memberId)`, six digits, to compare
   out loud.

### 8.3 What is secret

| Item                           | Secret?                                                         | Plain SMS OK?                                                               |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Invite seed                    | **Yes**: it is the join capability                              | Yes. That is the design: it is single-use, expires, and is scoped to a role |
| teamId                         | No, but it reveals the team's LAN presence to anyone who has it | Yes                                                                         |
| Expiry (display copy)          | No                                                              | Yes                                                                         |
| Hotspot SSID and password      | Short-lived, local only                                         | **No**: QR only, never encoded for SMS or links                             |
| Names, phone numbers, team key | Never in a token                                                | —                                                                           |

### 8.4 Threat model

| Threat                              | Outcome                                                                                                               | Mitigation                                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The SMS is intercepted or forwarded | The holder can join as the invite's role, until expiry or the use limit. They also need to reach the team's LAN (MVP) | Single use by default; short expiry (48 h for SMS suggested); scoped role, guest for strangers; `ap:'admin'` invites need an admin present; admins see who joined via which invite (`inviteId` on the member) and can remove and rotate; safety code check |
| Replay of a captured join proof     | Useless: it admits the _joiner's_ key, which the attacker doesn't hold. A second use fails "used"                     | Proof binds teamId, joiner key and X25519 key                                                                                                                                                                                                              |
| Expired invite                      | Refused by the admitting member's wall clock **and** by every peer's fold (the admit's HLC must be ≤ expiry)          | A member colluding to backdate an admit is an insider: removal + rotation                                                                                                                                                                                  |
| Guessing an invite                  | 128-bit seed                                                                                                          | —                                                                                                                                                                                                                                                          |
| Revocation racing admission         | The total order decides; the UI must show "joined just before revocation"                                             | `i.revoke` + `m.remove`                                                                                                                                                                                                                                    |
| Rogue peer feeding a fake team      | Impossible without a 128-bit second preimage on `teamId`                                                              | Genesis must derive `teamId`                                                                                                                                                                                                                               |

## 9. Routing and notifications (`notify.ts`)

**Fan-out is total; delivery is targeted.** Every phone stores and relays
every op (that is the redundancy owner B8 asked for). The audience decides what
each phone _does_ with it.

- **Audience** = union of explicit member ids (`m`), roles (`r`), group
  subtrees (`g`) and "leads only" (`l`). No audience means the whole team.
- **Priority:**
  - important (1): any member;
  - urgent (2): admins to anyone; a group lead only to their own subtree.
  - Invalid priorities reject the op in the fold.
- **Delivery** per phone is `none | silent | badge | alert`. The first rule
  that matches wins:
  1. my own op, or I'm inactive → `none`;
  2. outside the audience → `none`;
  3. positions → `silent`;
  4. a task assigned to me → `alert`; other entity edits → `silent`;
  5. urgent, mention, DM → `alert`; important → `badge` (`alert` if from an
     admin);
  6. a normal message → `badge` when the team or audience is ≤ 30 people, or
     the sender is an admin or a lead of one of my groups; otherwise `silent`.
     A 100-person event's chatter doesn't buzz every phone.
- **Confidentiality ≠ audience.** A group-mode op with an audience is readable
  by every member's app. Use sealed mode for privacy.

## 10. Sync (`sync.ts`, `log.ts`, `replica.ts`)

### 10.1 Handshake (SIGMA)

```
I → R  hi1 {v, tm, e:ephI, nn}
R → I  hi2 {e:ephR, id:R, mc:MAC_r(R), sg:Sign_R(T2)}   T2 = H("hs2" ‖ hi1 ‖ {e,id})
I → R  hi3 {id:I, mc:MAC_i(I), join?, sg:Sign_I(T3)}     T3 = H("hs3" ‖ T2 ‖ hi3−sg)
DH = X25519(ephI, ephR);  MAC_x(id) = HMAC(HKDF(DH, T2, "confirm-x"), id)
k_i2r, k_r2i = HKDF(DH, salt=T3, "i2r" / "r2i")
```

- Signatures bind both ephemeral keys. The identity MACs stop a relay from
  splicing its identity into someone else's session (tested).
- The responder continues only with an active member, or with a joiner whose
  proof it can admit.
- A member initiator refuses a responder that is not an active member. A
  joiner checks that as soon as it holds the log.
- After the handshake, each frame is XChaCha20-Poly1305 with a per-direction
  64-bit counter nonce. A tampered, replayed or reordered frame ends the
  session.

### 10.2 Anti-entropy

- **Version vector** = per author, the highest contiguous seq held. Gaps are
  fine: the next round asks again.
- **Pull.** Each side sends `vv`, then pulls what it lacks with `want` ranges:
  - at most 64 ranges per `want`, each at most 1024 seqs;
  - the owner and known members first, so membership arrives before the data
    that depends on it.
- **Serving.** The serving side answers `ops` frames in the total order, up to
  4096 ops per `want`, cut to the frame cap.
- **Push.** New local or relayed ops are pushed unsolicited.
- **Periodic re-sync.** `tick()` resends the vector.
- **Ephemeral ops** (positions) are not in the vector. They are pushed on open
  and live, and the newest unexpired one per author is kept.
- **Equivocation.** Two different ops for one (author, seq) are flagged. The
  first is kept, and the pair is evidence for the admins.
- **Quarantine.** Validly signed ops from not-yet-known authors are held: at
  most 512 ops and 1 MiB. They are released when an admission arrives.
- **Relay.** Any phone relays any other's ops. The result is path-independent;
  a three-phone relay test covers it.

### 10.3 Flood and abuse limits (`ratelimit.ts`)

|                                                    | LAN                                  | Relay (Nostr, later)             |
| -------------------------------------------------- | ------------------------------------ | -------------------------------- |
| Max frame (checked before decrypt or parse)        | 512 KiB                              | 128 KiB                          |
| Bytes/s (burst)                                    | 4 MiB (8 MiB)                        | 64 KiB (512 KiB)                 |
| Frames/s (burst)                                   | 200 (400)                            | 20 (60)                          |
| Unsolicited ops/s (burst): control, data, msg, pos | 5 (50), 20 (200), 10 (100), 60 (600) | 1 (20), 5 (50), 5 (50), 10 (100) |
| Ban                                                | 20 strikes/min → 10 min              | 10 strikes/min → 30 min          |

- **Strikes:** oversize, over-rate, malformed frame or envelope, forged
  signature, undecryptable frame, protocol violation.
- **Not strikes:** ops that are stale, expired, removed or skewed. Honest relays
  can carry those.
- The sealed-frame fuzz and abuse tests assert rejection without exceptions.

## 11. Replicated data (`crdt.ts`, `data.ts`, `photos.ts`)

### 11.1 Rules

- Per-field LWW registers keyed by HLC stamp.
- A tombstone wins an exact tie.
- A newer edit resurrects the record, but **only fields written after the
  delete** become visible again.
- An equivocated tie (one author, two values, same stamp) breaks on the
  canonical text, so every replica still agrees.
- Property tests (300–1000 seeded random cases each) check that register, entity and map
  merges are commutative, associative and idempotent, and that any op order or
  duplication converges.

### 11.2 Kinds

| Kind                        | Ownership                      | Notes                                                |
| --------------------------- | ------------------------------ | ---------------------------------------------------- |
| `wpt`, `point`, `task`      | shared                         | anyone writes or deletes                             |
| `track`, `photo`, `comment` | owned: key `(kind, owner, id)` | only the owner writes; the owner or an admin deletes |
| `msg`                       | owned, immutable               | the first write wins; redaction is `e.del`           |
| positions                   | one register per member        | only that member writes                              |

Owned keys include the owner, so nobody can hijack a record by backdating a
write to its id.

### 11.3 Blobs (stage 3)

- `contentHash` identifies the bytes.
- Thumbnails are always synced; full resolution on demand or on Wi-Fi
  (owner B5).
- Transfer: chunked and resumable, encrypted with the epoch key, verified by
  hash, with per-peer caps.
- Blob bytes never travel inside ops.

## 12. Security properties and threat model

| Threat                                       | Protected?              | How / residual risk                                                                                                                                                  |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eavesdropper on the Wi-Fi or hotspot         | Yes                     | Session AEAD. Op bodies are encrypted end to end anyway                                                                                                              |
| Outsider forges ops                          | Yes                     | Ed25519 on every op; invalid signatures are struck                                                                                                                   |
| A member forges another's ops                | Yes                     | Same                                                                                                                                                                 |
| A member escalates privileges                | Yes                     | The fold checks authority at each op's position                                                                                                                      |
| Removed member keeps sending                 | Yes                     | `cut` + status; past the cut, ops are refused even backdated, and not stored                                                                                         |
| Removed member reads new data                | Yes, after rotation     | Fail-closed send key. **Residual:** everything they already had stays on their phone (no remote wipe; the UI must say so)                                            |
| Replay of ops                                | Yes                     | Content-addressed ids; per-author seq; equivocation detection                                                                                                        |
| Replay of session frames                     | Yes                     | Counter nonces; the session dies                                                                                                                                     |
| Clock skew                                   | Bounded                 | > 24 h ahead is refused. **Residual:** a member can backdate within the past (e.g. write into a closed or expired team's history), visible as an old stamp. Accepted |
| Oversized or malformed payloads, floods      | Yes                     | Caps before parsing, token buckets, strikes, bans. Fuzz-tested: never throws                                                                                         |
| Malicious member equivocates (two histories) | Detected, not prevented | Peers may diverge on that author's ops; evidence is surfaced so an admin removes them                                                                                |
| Malicious admin                              | No (trusted role)       | Can add or remove members, rotate, close. The owner can demote them with a cut                                                                                       |
| Lost phone                                   | Partly                  | Remove + rotate. The phone's local copy is only as safe as its lock screen and the secure store                                                                      |
| Metadata to relays                           | Partly                  | Envelopes reveal team id, author key, type, size, timing, audience. Nostr will gift-wrap them (§13)                                                                  |
| Forward secrecy inside an epoch              | No                      | See §7. Rotate on removal; MLS later                                                                                                                                 |

## 13. What changes for Nostr relays (opt-in, after the MVP)

Owner B1 and B2: third-party relays, opt-in per team, and Inukshuk hosts
nothing.

- **The transport changes; ops stay the same.** A relay is a mailbox, not a
  peer: there is no handshake, no `want`, and no session crypto.
- **Wrapping.** Each envelope goes out in a NIP-59 gift wrap: NIP-44 v2
  encryption under a key derived from the current epoch key, signed by a
  throwaway Nostr key. The relay sees neither the author key, the type nor the
  audience.
- **Rendezvous.** The `#p`/`#t` tag is `HMAC(epochKey, "nostr" ‖ day)`. It
  rotates daily and per epoch, so outsiders can't link a team's events.
- **Lifetime.** NIP-40 `expiration` is set to the team's expiry, so relays drop
  the events when the team ends.
- **Catch-up.** Without a vector, peers query by tag and `since`, then use the
  same `OpLog`. Duplicates are free: content addressing.
- **Positions** use the ephemeral event kinds (20000–29999).
- **Limits** switch to `RELAY_LIMITS`, with event sizes ≤ 64 KiB. Large
  rotations split into one op per ≤ 200 members; that needs a v2 `k.rotate`
  "part" field, which is why the field set is frozen only for v1.
- **Blobs** are not sent over Nostr (thumbnails at most, e.g. Blossom; fit
  unverified).
- **Abuse.** Relays are shared with strangers. Ops are still validated, and a
  flood from a team member costs strikes against that _author_: the client
  stops fetching their tag after a ban.

## 14. What the paid hosted relay (#590) adds

- **It is just another peer that can't read.** It runs this exact
  handshake and sync. It stores envelopes and encrypted blobs, and it never
  holds a team key.
- **Protocol addition (v2):** a `relay` role, enabled by an admin-signed
  control op naming the relay's key.
  - It may hold and serve ops.
  - It cannot author data, cannot admit, and never gets wraps.
  - The protocol does not assume a host phone, and phone numbers are not
    identities, so no data migration is needed.
- **Service add-ons outside the protocol:**
  - push wake-ups (APNs/FCM need server credentials, so they exist only here);
  - account and billing;
  - longer retention, compaction snapshots signed by the owner;
  - MLS's ordering service if we move to MLS.
- **Serverless stays free** (owner B11). The relay only adds availability.

## 15. Open questions for the owner

Listed in the stage-1 PR. They are tap-answerable choices, with the
recommended default marked. The code ships the defaults below.

| Question                             | Code default                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| SMS invite default lifetime and uses | 48 h, single use (UI default; the protocol allows ≤ 30 d, ≤ 1000 uses)                                |
| Who may admit with an invite         | Any member. Admin-only is per invite (`ap:'admin'`)                                                   |
| Do new members read team history?    | Yes, they receive the current epoch key. History before the last rotation needs an explicit `k.share` |
| Removed or demoted admins            | Never re-promoted. Rejoin with a new device                                                           |
| Ownership transfer                   | Not in v1 (the owner key is permanent)                                                                |
| Large-team notification threshold    | 30                                                                                                    |
| Guests                               | Read, positions and messages; no shared-record edits                                                  |
