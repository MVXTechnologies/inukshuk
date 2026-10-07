# Team protocol v1 (serverless team mode, #589)

Stage 1: the pure protocol core in `src/core/team/`. Read this before you
touch team code, the mesh transport (`modules/inukshuk-mesh`), the Nostr
transport, or the paid hosted relay (#590).

**Status (2026-10-07):** stage 1 is pure TypeScript with tests, including the
noble crypto implementation. Nothing is wired: there is no transport, no
persistence, no UI and no native CSPRNG binding yet (§4.3). Research and owner decisions are in
`~/Documents/inukshuk-saved/research-gnss-team/` (`TEAM.md`,
`OWNER-ANSWERS-2026-10-06.md`) and on #589.

## 1. What is built and what is not

| In stage 1 (`src/core/team/`)                                                                                     | Later                                                |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Crypto interface, noble implementation, Node test double (`crypto.ts`, `nobleCrypto.ts`, `testing/nodeCrypto.ts`) | The native CSPRNG binding via `expo-crypto` (§4.3)   |
| Identities, team ids, op ids (`ids.ts`)                                                                           | Key storage in `expo-secure-store` (`src/data/team`) |
| Signed, encrypted op envelope (`envelope.ts`)                                                                     | Blob transfer: photos, track files (§11.3)           |
| Membership log and its validation (`membership.ts`)                                                               | `modules/inukshuk-mesh`: LAN/hotspot TCP, mDNS (§12) |
| Team-key epochs, wraps, rotation (`keys.ts`, `actions.ts`)                                                        | Nostr relay transport (§13)                          |
| Invites for SMS, link and QR (`invite.ts`)                                                                        | UI, notifications, map layer                         |
| CRDTs and the data view (`crdt.ts`, `data.ts`, `photos.ts`)                                                       | Compaction and snapshots                             |
| Notification routing (`notify.ts`)                                                                                |                                                      |
| Op log, per-author hash chains and version vectors (`log.ts`, `chain.ts`), replica (`replica.ts`)                 |                                                      |
| Sync session state machine, rate limits (`sync.ts`, `ratelimit.ts`)                                               |                                                      |

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

### 4.3 Implementation: noble (PM decision 2026-10-07, owner to confirm)

`nobleCrypto.ts` implements `TeamCrypto` with three libraries, pinned exactly
in package.json:

| Package          | Version | Used for           |
| ---------------- | ------- | ------------------ |
| `@noble/curves`  | 2.4.0   | ed25519, x25519    |
| `@noble/hashes`  | 2.4.0   | sha256, hmac, hkdf |
| `@noble/ciphers` | 2.4.0   | xchacha20poly1305  |

- They are pure JavaScript and safe on Hermes, with no native module. **The
  runtime fingerprint is unchanged**: iOS `97bbf630…` and Android `6a193496…`
  were computed with and without the dependencies on 2026-10-07. No store
  release is needed for them.
- They are synchronous, which suits the `TeamCrypto` interface.
- They have been audited: Cure53 (2024) and Trail of Bits (2023; 2026 for
  curves).
- Verification is strict RFC 8032 (`zip215: false`). A test checks that a
  malleated `S + L` signature is refused by both implementations.
- They are ESM-only, so Jest transforms `@noble/*` (`jest.config.js`). Metro
  resolves their `exports`.
- Speed upgrade if profiling asks for it: `react-native-quick-crypto` (JSI).

**Randomness.**

- Hermes has no `crypto.getRandomValues`, and Expo SDK 56's runtime does not
  install one (its winter runtime adds fetch, URL and TextDecoder, but no
  crypto). expo-modules-core's uuid helper is not a byte source either.
- The app has no CSPRNG today: `nanoid` is imported as `nanoid/non-secure`.
- So `createNobleCrypto(fillRandom)` takes the CSPRNG as a parameter, and every
  key, nonce, invite seed and ephemeral key comes from it. noble's own
  `randomBytes` is never called. If someone reached for it, it would throw on
  Hermes (fail closed) rather than fall back to `Math.random`.
- The platform binding (stage 2, in the same store release as
  `modules/inukshuk-mesh`): add `expo-crypto` (`npx expo install expo-crypto`;
  it is a native module, so it changes the fingerprint) and pass
  `(buf) => Crypto.getRandomValues(buf)`. That uses the native CSPRNG
  (`SecRandomCopyBytes` / `SecureRandom`).
- Use `getRandomValues`, not `getRandomBytes`: per the SDK 56 docs,
  `getRandomBytes` can fall back to `Math.random` in development.
- Never install a JS `getRandomValues` polyfill.

**Tests.**

- `crypto.vectors.test.ts` runs the RFC 8032, RFC 7748, RFC 5869, RFC 4231,
  FIPS 180-2 and draft-irtf-cfrg-xchacha vectors against **both** noble and
  the Node test double. It also checks that the two interoperate in both
  directions.
- `nobleCrypto.test.ts` runs the whole protocol (create, invite, join over a
  session, messages) with noble on one or both sides.
- The other suites use the Node double for speed.

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
{ v:1, tm, au, sq, pv?, hc:[wallMs,counter], t,
  b?, aud?, pr?, ttl?, k? | x?:{e, cc, w:[[memberId, wrappedCek]…]}, n?, c?, sg }
```

| Field    | Meaning                                                                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`      | Protocol version (1)                                                                                                                                                                          |
| `tm`     | teamId: 16 bytes of `SHA-256(label ‖ ownerPub ‖ genesisNonce)`                                                                                                                                |
| `au`     | Author memberId                                                                                                                                                                               |
| `sq`     | Per-author sequence: 1, 2, 3… for logged ops, 0 for ephemeral ops                                                                                                                             |
| `pv`     | Id of the author's previous logged op (seq − 1): a signed per-author hash chain. Required from seq 2, absent at seq 1 and on ephemeral ops                                                    |
| `hc`     | HLC `[wall ms ≥ 2020, counter ≤ 65535]`                                                                                                                                                       |
| `t`      | Op type (§5.3)                                                                                                                                                                                |
| `b`      | Control body, **in clear** (authority data every peer must check)                                                                                                                             |
| `aud`    | Audience (§9), canonical form only                                                                                                                                                            |
| `pr`     | Priority: 1 important, 2 urgent (`msg` only)                                                                                                                                                  |
| `ttl`    | Seconds, 1–86400, ephemeral ops only                                                                                                                                                          |
| `k`      | Group-mode key id (12-byte hash of the epoch key). The body key is `HKDF(epochKey, teamId, "payload")`, never the epoch key itself                                                            |
| `x`      | Sealed mode: ephemeral X25519 key `e`, key commitment `cc = HKDF(cek, teamId, "commit")`, and the content key wrapped per recipient (≤ 64). A recipient refuses a key that doesn't match `cc` |
| `n`, `c` | Nonce and ciphertext of the canonical-JSON body (data ops) or labels (control ops)                                                                                                            |
| `sg`     | Ed25519 over `"inukshuk/team/v1/op\n" ‖ canonical(envelope − sg)`                                                                                                                             |

- **opId** = SHA-256 of those signing bytes. It is the dedupe id and the `pv`
  link of the author's next op.
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

| Type                    | Class     | Who                                                | Body                                                                               |
| ----------------------- | --------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `m.genesis`             | control   | creator (becomes owner)                            | `{nonce, x, exp, kw}`, where `kw` wraps key 0 for the owner                        |
| `m.add`                 | control   | admin+                                             | `{m, x, r, g?, from?, kw}`                                                         |
| `m.admit`               | control   | member+ (an admin if the invite says `ap:'admin'`) | `{m, x, inv, ip, js, kw}` (join proof + key wrap)                                  |
| `m.update`              | control   | admin+                                             | `{m, r?, g?, cut?, from?}`; `cut = [seq, opId]` is required when demoting an admin |
| `m.remove`              | control   | admin+                                             | `{m, cut}` with `cut = [seq, opId]` (or `[0]`): the target's chain head            |
| `i.create` / `i.revoke` | control   | admin+                                             | `{inv, exp, max, r, g?, ap}` / `{inv}`                                             |
| `g.set` / `g.del`       | control   | admin+                                             | `{id, p?}` / `{id}`                                                                |
| `t.extend` / `t.close`  | control   | admin+                                             | `{exp}` / `{}`                                                                     |
| `k.rotate`              | control   | admin+                                             | `{kw}` with exactly one new key                                                    |
| `k.share`               | control   | any member holding the key                         | `{kw}` re-wrapping existing keys for active members                                |
| `e.set` / `e.del`       | data      | member+                                            | `{k:kind, id, f:{field:value}}` / `{k, id, o?}`                                    |
| `msg`                   | data      | guest+                                             | `{id, th, tx ≤ 4000, mn?}`                                                         |
| `pos`                   | ephemeral | guest+                                             | `{la, lo, ac?, el?, at}`                                                           |

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
- **Backdating and forking defence (cuts + chains, review H3).** HLCs are
  chosen by the author, so a removed or demoted member could sign ops with
  old timestamps, or a different op at an old seq.
  - Every logged op names its predecessor (`pv`): each author's ops form a
    signed hash chain. Only the **canonical chain** is folded (`chain.ts`).
  - `m.remove` and admin demotions carry `cut = [seq, opId]`: the head of the
    target's chain as the remover saw it (`cutFor`).
  - The target's ops with `sq > seq` are rejected (removal) or lose admin
    authority (demotion), wherever their HLC sorts.
  - At or below the cut, the chain is pinned top-down from `opId` through the
    `pv` links. A different op at an old seq is never canonical, on any peer,
    whatever arrived first.
  - A peer that holds a forged op where the pinned chain needs another sees its
    chain (and version vector) shrink, pulls the real op again, and admits it
    even past the fork cap.
  - Work the target did that the remover had not yet received is lost. That is
    the price of determinism without a server.
  - Removal cuts are enforced in a second pass. Admin cuts can only come from
    the always-authoritative owner, so they are collected up front.
  - The owner's chain is pinned at seq 1 to the chosen genesis, so a second
    genesis the owner signs is a fork, never an alternative team.
  - A demoted admin cannot be re-promoted in v1.
  - A removed device cannot be re-added; it rejoins with a new key.
- **Equivocation by an active member** (two ops for one seq): both signed ops
  are kept as proof (at most 4 per seq). Until an admin removes the member
  (which anchors their chain), the lowest op id wins at each seq. That is
  deterministic for a given op set; the pushed evidence spreads both ops.
- **Positional authority (review M4).** A data op's author role is recorded at
  its fold position (`roleAt`). A delete made as a member stays forbidden after
  a later promotion.
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
  - **A rejected admission can still hand out a key (review H1), so leaks
    are advisory (re-review #3).** The losing `m.admit` of an invite race was
    delivered to its joiner with a wrap of the live key.
  - It counts as a leak only when all of these hold:
    - it lost for a race-type reason (`invite`, `exists`, `limit`, `expired`,
      `closed`);
    - its author could admit: an active non-guest with a verified proof against
      an existing invite, or an admin for `m.add`;
    - its wraps go to **exactly the joiner**, who has **never been a member**;
    - the author holds every wrapped key;
    - it is the **first** such op for that (invite, author).
  - A leak sets `rotationAdvised`; it does **not** block writes. Admin replicas
    auto-rotate, at most once per leaking author per 30 min
    (`AUTO_ROTATE_INTERVAL_MS`).
  - Every other rejected wrap-carrying op is only recorded in `wrapEvidence`.
  - **Trade-off.** Fail-closed (block sending until a rotation) protects
    nothing here: the holder already has the key and everything sent under it.
    Meanwhile any member able to manufacture a "leak" could stop the whole team,
    over and over. Advisory keeps the team working and closes the window at the
    next rotation (seconds when an admin is online). It accepts that messages
    sent before then are readable by that one joiner, who held a valid invite.
  - **Removal stays fail-closed** (`needsRotation`): only admins can remove, so
    it cannot be spammed.
  - Counted leaks are deduplicated per (invite, author, key). A second real
    loss after a rotation is advised again.
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
6. Both phones can show the session's `safetyCode` (six digits, §10.1) to compare
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

| Threat                                 | Outcome                                                                                                                                                                                  | Mitigation                                                                                                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The SMS is intercepted or forwarded    | The holder can join as the invite's role, until expiry or the use limit. They also need to reach the team's LAN (MVP)                                                                    | Single use by default; short expiry (48 h for SMS suggested); scoped role, guest for strangers; `ap:'admin'` invites need an admin present; admins see who joined via which invite (`inviteId` on the member) and can remove and rotate; safety code check |
| Replay of a captured join proof        | Useless: it admits the _joiner's_ key, which the attacker doesn't hold. A second use fails "used"                                                                                        | Proof binds teamId, joiner key and X25519 key                                                                                                                                                                                                              |
| Expired invite                         | Refused by the admitting member's wall clock **and** by every peer's fold (the admit's HLC must be ≤ expiry)                                                                             | A member colluding to backdate an admit is an insider: removal + rotation                                                                                                                                                                                  |
| Guessing an invite                     | 128-bit seed                                                                                                                                                                             | —                                                                                                                                                                                                                                                          |
| Revocation racing admission            | The total order decides; the UI must show "joined just before revocation"                                                                                                                | `i.revoke` + `m.remove`                                                                                                                                                                                                                                    |
| Two joiners race one single-use invite | The loser was handed the current key by its admitting member and keeps it **until the next rotation**. **While no admin replica is online**, it can read new team traffic in that window | `rotationAdvised` is raised on every member's phone (shown in the UI); an admin replica auto-rotates as soon as it syncs (≤ 1 per member per 30 min); writes are never blocked. Trade-off in §7                                                            |
| Rogue peer feeding a fake team         | Impossible without a 128-bit second preimage on `teamId`                                                                                                                                 | Genesis must derive `teamId`                                                                                                                                                                                                                               |

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

### 10.1 Handshake (SIGMA, identities hidden)

```
I → R  hi1 {v, tm, e:ephI, cm:H("commit" ‖ nI)}
R → I  hi2 {e:ephR, x:Seal_hs-r{id:R, mc:MAC_r(R), sg:Sign_R(T2)}}
I → R  hi3 {x:Seal_hs-i{id:I, mc:MAC_i(I), nn:nI, join?, sg:Sign_I(T3)}}
DH = X25519(ephI, ephR)    T1 = H("hs1" ‖ hi1 ‖ ephR)
T2 = H("hs2" ‖ T1 ‖ {id:R})    T3 = H("hs3" ‖ T2 ‖ hi3 inner − sg)
hs-r = HKDF(DH, T1, "hs-r"),  hs-i = HKDF(DH, T1, "hs-i")   (AAD T1 / T2)
MAC_x(id) = HMAC(HKDF(DH, T2, "confirm-x"), id)
k_i2r, k_r2i = HKDF(DH, T3, "i2r" / "r2i")
safetyCode = HKDF(DH, H("sas" ‖ cm ‖ nI ‖ ephI ‖ ephR), "safety") mod 10^6
```

- Signatures bind both ephemeral keys. The identity MACs stop a relay from
  splicing its identity into someone else's session.
- **Identities are encrypted** (decided over documenting the leak). A passive
  listener sees two ephemeral keys and the team id, never member ids or join
  proofs (tested).
  - **Residual:** an _active_ attacker who knows the team id (from an invite)
    can open a session and learn one responder's member id, because the
    responder identifies itself before the initiator does. It learns nothing
    else.
- **Safety code (review M3, re-review #4).**
  - It is derived from the DH secret and from values fixed before the
    initiator's nonce is revealed: the commitment `cm`, the nonce itself, and
    both ephemerals.
  - It does **not** depend on the rest of `hi3`. An earlier version hashed the
    whole transcript, so a man in the middle could vary its identity in `hi3`
    offline to grind the code.
  - So a man in the middle holding a stolen invite gets two independent random
    codes, matching with probability 10⁻⁶.
  - The handshake must finish within 30 s (`HANDSHAKE_TIMEOUT_MS`; checked on
    `receive` and on `tick(now)`). A stalled handshake is dropped with
    `timeout`.
- The responder continues only with an active member, or with a joiner whose
  proof it can admit.
- A member initiator refuses a responder that is not an active member. A
  joiner checks that as soon as it holds the log.
- After the handshake, each frame is XChaCha20-Poly1305 with a per-direction
  64-bit counter nonce. A tampered, replayed or reordered frame ends the
  session.

### 10.2 Anti-entropy

- **Version vector** = per author, the length of the canonical chain held
  (`chain.ts`). Gaps, or a fork where an anchor needs another op, shorten it,
  and the next round asks again. A session runs at most 64 follow-up `want`
  rounds per received vector.
- **Pull.** Each side sends `vv`, then pulls what it lacks with `want` ranges:
  - at most 64 ranges per `want`, each at most 1024 seqs;
  - the owner and known members first, so membership arrives before the data
    that depends on it.
- **Serving.** The serving side answers with its canonical chain ops, in total
  order, up to 4096 ops per `want`, cut to the frame cap.
- **Push.** New local or relayed ops are pushed unsolicited.
- **Periodic re-sync.** `tick()` resends the vector.
- **Ephemeral ops** (positions) are not in the vector. They are pushed on open
  and live, and the newest unexpired one per author is kept.
- **Equivocation.** Two different ops for one (author, seq) are flagged. Both
  signed ops are kept as proof (a provable equivocation); §6 says which counts.
  - The first proof refolds once.
  - After that, the author's further forks are stored as evidence only, and
    folded by a single coalesced refold at most every 10 s
    (`FORK_REFOLD_INTERVAL_MS`). A forking member cannot make peers refold per
    op (re-review #3).
  - An op the anchored chain pins always triggers a refold.
- **Gap buffer (re-review #3).** An op whose predecessor (`pv`) we don't hold
  is parked: not stored, not folded. It is promoted when the predecessor
  arrives.
  - The buffer holds at most 4096 ops and 8 MiB, with 256 ops and 1 MiB per
    author; the oldest entry is evicted first.
  - A pinned (chain-repairing) op bypasses it.
  - An op whose predecessor _is_ held but isn't that author's op at `sq − 1`
    can never be canonical. It is refused with `chain` (a strike), never stored.
- **Quarantine.** Validly signed ops from not-yet-known authors are held:
  - at most 512 ops and 1 MiB in total, and 64 per author;
  - the oldest entry is evicted first.

  They are released when an admission arrives.

- **Clock (review M1).**
  - Only ops the fold accepted move the local HLC, and never past now + 5 min.
  - Acceptance still allows 24 h of skew.
  - One far-future op therefore cannot drag honest clocks forward and get their
    later ops refused.
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

**Transport interface (for `modules/inukshuk-mesh`), unchanged by the review:**
`SyncSession.initiate / respond / receive(frame, now) → Step / push / tick /
close`. Frames are opaque bytes, delivered whole and in order. New: the
read-only `session.safetyCode` after open. Changed on the wire: the `hi1`/`hi2`/
`hi3` contents (§10.1), the envelope gains `pv` and `x.cc` (§5.2), and cuts are
`[seq, opId]`. The transport never parses any of it.

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

| Kind               | Ownership                      | Notes                                                                                 |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| Kind               | Ownership                      | Notes                                                                                 |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| `wpt`, `point`     | shared                         | any member writes or deletes                                                          |
| `task`             | owned: key `(task, owner, id)` | the owner writes; its assignee writes only the status; admins write; see §11.4        |
| `track`, `photo`   | owned: key `(kind, owner, id)` | only the owner writes; the owner or an admin deletes                                  |
| `comment`          | owned: key `(kind, owner, id)` | only the owner writes (guests too); the owner or an admin deletes                     |
| `msg`              | owned, immutable               | the first write wins; redaction is `e.del`; a pin is a `msg` with an anchor (§11.4)   |
| positions          | one register per member        | only that member writes                                                               |

Owned keys include the owner, so nobody can hijack a record by backdating a
write to its id.

**Guests only comment.** A guest may author `pos` and `msg` ops and `e.set` /
`e.del` of their **own** `comment` records. The op-type gate
(`roles.canWriteData`) lets guest `e.set`/`e.del` through and the data fold
narrows them by kind (`data.GUEST_KINDS`); every other guest entity write is
skipped as `forbidden`. The fold fails closed: an entity op without a
recorded role (`state.roleAt`) is forbidden.

### 11.4 Tasks and pins (`tasks.ts`, `teamui/pins.ts`)

**Tasks** are owned `task` entities, so the creator is part of the key and
can't be forged. Fields (each validated on every write; an unknown or
malformed field makes the whole op `invalid`):

| Field                    | Meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `title`                  | 1–500 chars, not blank                                            |
| `assignee`               | a member id                                                       |
| `due`                    | epoch ms or `null`                                                |
| `ak`, `ao`, `ai`         | anchor: `photo` / `pin` / `trail` + its owner and id              |
| `ak = point`, `la`, `lo` | anchor: a place                                                   |
| `so`, `sc`               | the comment or message it was made from (`+task @name …`)         |
| `done`, `dby`, `dat`     | status; `dby` must equal the op's author (no "done in your name") |

Authorization, by the author's role **at the op's place in the fold**:

- `e.set {k: 'task', id, f}` without `o` writes the author's own task;
- `e.set {k: 'task', id, o, f}` updates `o`'s **existing, live** task
  (nobody, admins included, creates a task in another member's name):
  allowed for an admin (any field), or for the task's **current** assignee (the visible
  `assignee` at that point of the fold) when `f` holds only `done`, `dby`,
  `dat`. Anything else is `forbidden`. `o` is accepted on tasks only;
- the owner or an admin deletes (`e.del` with `o`, the owned rule);
- guests write no tasks.

Because the fold is in the team's total order and the replica rebuilds when
an op lands in the middle, "current assignee" is the same on every phone:
a status write after a reassignment (in that order) by the old assignee is
`forbidden` everywhere. **Accepted residual:** order is by HLC stamp, which an
author chooses within the clock-skew bound, so a former assignee can backdate
a completion to before the reassignment. Readers flag it: a task whose `done`
register is older than its `assignee` register shows "completed before
reassignment" (`TeamTask.doneBeforeReassignment`). Property tests replay random histories from five
roles (owner, creator, assignee, another member, guest) in shuffled orders
and check convergence and that no guest owns or completes a task.

**Pins** (comments anchored to a place) are messages on the thread
`pin:<owner>:<id>`. The root is `<owner>`'s message whose own id is `<id>`,
carrying `ll = [lng, lat]` (finite, in range). An anchored message on any
other thread, or by anyone but the owner the thread names, is `invalid`, so
nobody can root, backdate or move someone else's pin; messages are immutable,
so the owner can't move it either (a new pin is a new thread). Replies are
plain messages on the thread, from anyone. Guests may pin and reply.
Redacting the root removes the pin. "On the trail" vs "off the trail" is computed by the reader
(distance to a shown trail ≤ 40 m), never stored.

**Alerts** (`teamui/alerts.ts`) fire only for ops the fold **applied**
(accepted with a role and not skipped as forbidden or invalid), and a task
alert's text comes from the merged, validated task (title capped at 120
chars), never from the op body. A task whose `assignee` becomes me alerts
me; my own task marked done by someone else alerts me; a reply on my pin
alerts me; a new pin follows the normal-message rule. Task alerts from one
teammate collapse: the first in 60 s notifies, the rest only update the
banner ("3 task updates for you"). The throttle is per author and per device, so colluding
members can each still raise one full alert per 60 s (accepted).

### 11.5 Team trails, SOS, rally points, resolved messages (`records.ts`)

Owner decisions 2026-10-07. Every field is validated on every write; a
malformed op is `invalid`, a well-formed one the author may not write is
`forbidden`; authority is the author's role at the op's place in the fold.

| Kind                    | Key                                                                      | Writes                                                                                                                                | Deletes          |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `trl` team trail        | owned (creator)                                                          | creator: all fields; members: `name`, `desc`, `color` of a live trail; `base` only at creation, never again (not even by the creator) | creator or admin |
| `tve` trail vertex      | shared, id `<trail>_b<i>` (base vertex) or `<trail>_<random>` (inserted) | members, only on a live `trl` (`to`, `tr` name it); a base vertex never takes a key                                                   | members          |
| `sos`                   | owned (raiser)                                                           | the raiser, guests too (a raise needs `la`, `lo`); the raiser or an admin: the resolution only                                        | raiser or admin  |
| `rly` rally point       | owned (creator)                                                          | the creator (members; no `o`)                                                                                                         | creator or admin |
| `mres` message resolved | owned by the **message's** author, id = the message id                   | its author, an admin, or a member the message mentions (guests too); the message must be live                                         | author or admin  |

**Trail editing CRDT.** A team trail's `base` is an immutable polyline;
vertex `i` of it has the fractional key `h` + 4 base-36 digits. A `tve`
record moves a base vertex (`la`, `lo`, LWW per field), an `e.del` deletes it
(a newer move resurrects it), and an inserted vertex carries its own key `k`,
made between its neighbours' keys (`keyBetween`; ties break on the id). The
trail is the live vertices sorted by key: a function of the op set, so every
phone converges (property test: random concurrent moves, inserts and deletes
from three members, shuffled). Undo is the client re-writing the previous
value of its own last edit; "editing" presence is an ordinary message.

**Status writes are whole**: `res: true` with `rby` = the author and `rat`;
`res: false` with both null (as tasks).

**SOS alerts** every active member except the raiser at once: always an
`alert`, priority 2, never collapsed by the task throttle and not subject to
the 30-member rule; the text comes from the merged record. A resolution is a
badge (the raiser: "Your SOS was resolved"). The raiser's live position is the
ordinary position register.

**Resolved messages** (pins, notifies) leave the map and the unread counts and
stay listed under "Resolved"; nothing is deleted. Resolving is reversible by
the same set of people.

### 11.3 Blobs (stage 3)

- `contentHash` identifies the bytes.
- Thumbnails are always synced; full resolution on demand or on Wi-Fi
  (owner B5).
- Transfer: chunked and resumable, encrypted with the epoch key, verified by
  hash, with per-peer caps.
- Blob bytes never travel inside ops.

## 12. Security properties and threat model

| Threat                                                                | Protected?                             | How / residual risk                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eavesdropper on the Wi-Fi or hotspot                                  | Yes                                    | Session AEAD. Op bodies are encrypted end to end anyway                                                                                                                                                                                                                      |
| Outsider forges ops                                                   | Yes                                    | Ed25519 on every op; invalid signatures are struck                                                                                                                                                                                                                           |
| A member forges another's ops                                         | Yes                                    | Same                                                                                                                                                                                                                                                                         |
| A member escalates privileges                                         | Yes                                    | The fold checks authority at each op's position                                                                                                                                                                                                                              |
| Removed member keeps sending                                          | Yes                                    | `cut` + status; past the cut, ops are refused even backdated, and not stored                                                                                                                                                                                                 |
| Removed member rewrites old history                                   | Yes (H3)                               | The cut pins the hash chain; a different op at an old seq is never canonical, and peers re-pull the real one                                                                                                                                                                 |
| Loser of an invite race / late admit keeps the key                    | Until the next rotation (H1, advisory) | Verified, joiner-only, first-per-invite-and-key leaks set `rotationAdvised` (shown to members); admin replicas auto-rotate (≤ 1 per member per 30 min); writes never block. **Residual: while no admin replica is online, the loser can read new traffic until a rotation.** |
| Junk chain links or oversized parked ops (rebuild or storage DoS)     | Yes (re-review #4)                     | An op whose held `pv` isn't the author's op at `sq − 1` is refused (`chain`, a strike); only chain-extending or pinned ops force an immediate rebuild; the gap buffer is byte-capped                                                                                         |
| Guest or member spams wraps or replays join proofs to force rotations | Yes (re-reviews #1, #3)                | Anything not meeting every leak rule is evidence only (`wrapEvidence`); counted leaks are one per invite and author and only advise                                                                                                                                          |
| Hostile field names (`toString`, `__proto__`…)                        | Yes (H2)                               | Null-prototype dictionaries and own-property reads in every merge; fuzz-tested                                                                                                                                                                                               |
| MITM with a stolen invite during a join                               | Detectable (M3)                        | The 6-digit safety code is transcript-bound with a committed nonce: 10⁻⁶ chance to match                                                                                                                                                                                     |
| Small-order Ed25519 keys (forge-anything signatures)                  | Yes                                    | Every implementation refuses small-order public keys (RFC vector test)                                                                                                                                                                                                       |
| Removed member reads new data                                         | Yes, after rotation                    | Fail-closed send key. **Residual:** everything they already had stays on their phone (no remote wipe; the UI must say so)                                                                                                                                                    |
| Replay of ops                                                         | Yes                                    | Content-addressed ids; per-author seq and hash chain; equivocation detection                                                                                                                                                                                                 |
| Replay of session frames                                              | Yes                                    | Counter nonces; the session dies                                                                                                                                                                                                                                             |
| Clock skew                                                            | Bounded                                | > 24 h ahead is refused; the local clock never leads by more than 5 min (M1). **Residual:** a member can backdate within the past (e.g. write into a closed or expired team's history), visible as an old stamp. Accepted                                                    |
| Oversized or malformed payloads, floods                               | Yes                                    | Caps before parsing, token buckets, strikes, bans. Fuzz-tested: never throws                                                                                                                                                                                                 |
| Malicious member equivocates (two histories)                          | Detected, provable                     | Both signed ops are kept and pushed; a deterministic rule picks one; removal anchors the chain. **Residual:** a member who signs more than 4 forks per seq can leave peers on different forks until removed                                                                  |
| Malicious admin                                                       | No (trusted role)                      | Can add or remove members, rotate, close. The owner can demote them with a cut                                                                                                                                                                                               |
| Lost phone                                                            | Partly                                 | Remove + rotate. The phone's local copy is only as safe as its lock screen and the secure store                                                                                                                                                                              |
| Metadata to relays                                                    | Partly                                 | Envelopes reveal team id, author key, type, size, timing, audience. Nostr will gift-wrap them (§13). Session handshakes hide identities (§10.1)                                                                                                                              |
| Forward secrecy inside an epoch                                       | No                                     | See §7. Rotate on removal; MLS later                                                                                                                                                                                                                                         |

## 12a. Performance (review M2)

- **Coalesced rebuilds.**
  - Membership ops that extend a held chain, and pinned ops, fold immediately.
    Other control ops, such as forks, wait for the coalesced rebuild.
  - Data-only batches that can't append rebuild at most once per second
    (`MIN_REFOLD_GAP_MS`); a forking author's further forks at most every 10 s.
  - Deferred work is folded by the next read (`data()`), the next due ingest,
    or `flush(now)`, which `SyncSession.tick(now)` calls. An idle replica still
    converges.
  - The version vector comes from the chains _held_, so sync never waits on a
    deferred fold.
- **What triggers a refold.**
  - Positions never enter the membership fold. They are checked against the
    current state when read, and the positions view is cached until a new
    position, a refold, or the first expiry.
  - A batch that only appends (each op sorts after the fold head and extends
    its author's chain) is applied incrementally, to the fold and to the data
    view.
  - Anything else refolds once per batch: old ops arriving, forks, removals,
    role changes.
- **Budget test** (`perf.test.ts`): 500 members, 20,000 data ops from 40
  writers, ingested in 200-op frames, then 500 positions.

  Node with the OpenSSL double, 2026-10-07:

  | Measure                                              | Result     | Test asserts                                     |
  | ---------------------------------------------------- | ---------- | ------------------------------------------------ |
  | Ingest                                               | 0.13 ms/op | **0 rebuilds**; ceiling 10 ms/op                 |
  | Position                                             | 0.13 ms/op | **0 rebuilds**; ceiling 10 ms                    |
  | Append + fold                                        | 0.3 ms     |                                                  |
  | `m.add` while building the team                      | 0.45 ms    |                                                  |
  | `data()` full build of 20k entities (after a refold) | ~0.5 s     |                                                  |
  | `data()` first read after 500 new positions          | ~12 ms     |                                                  |
  | `data()` after an append                             | < 0.1 ms   | **0 rebuilds, same cached view**; ceiling 100 ms |

  The primary assertions count work (full refolds), not time. The wall-clock
  ceilings are 10–100× the measured values: they never flake on a loaded runner
  (20/20 runs under parallel load) yet still catch a per-op rebuild.

  Before this change: 6.4 ms per position update, 332 ms per `data()`, and
  35 s for 20k sequential writes.

- **Full rebuild of a 100k-op single-author log: 0.24 s locally, about 0.6 s on
  a 2-core CI runner with coverage** (`review.test.ts`, budget 5 s, which
  still catches the regression by 25×). Max seqs are tracked incrementally and no unbounded collection
  is ever spread into a call. Before re-review #2 the same rebuild took 141 s,
  and at 200k it overflowed the stack.

- **noble admission** (canonical JSON + SHA-256 + strict Ed25519 verify) costs
  0.9 ms/op under Node's JIT.
  - Hermes has no JIT, and BigInt-heavy curve code runs several times slower
    there. Expect a few ms per verified op.
  - So a phone's first sync of a 20k-op team spends tens of seconds verifying
    signatures.
  - Mitigations for stage 2:
    1. persist ops as verified, so a relaunch does not re-verify;
    2. verify in batches off the UI thread;
    3. if profiling on a mid-range Android confirms it, move Ed25519 verify to
       `react-native-quick-crypto` (native, JSI), which keeps the same
       interface.

## 12b. v1 rules for native and UI consumers (confirmed after the security review)

These are frozen with the v1 envelope. The data layer, the mesh module and the
UI must follow them.

| Rule                         | What it means for you                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`pv` chaining**            | Every logged op from seq 2 carries `pv` = the id of the same author's previous logged op. `OpWriter` sets it. **Persist `WriterCursor = {seq, hlc, prev}` after every write** and restore it on launch. Losing `prev` (or `seq`) forks the device's own chain, which peers treat as equivocation |
| **`x.cc`**                   | Sealed ops carry `cc = HKDF(cek, teamId, "commit")`. Readers refuse a content key that doesn't match it. Build sealed ops only with `buildOp`                                                                                                                                                    |
| **Payload subkey**           | Group-mode bodies are encrypted with `payloadKey(epochKey) = HKDF(epochKey, teamId, "payload")`, never the epoch key itself. Future uses of the epoch key (e.g. Nostr tags) must derive their own labelled subkey                                                                                |
| **Cuts**                     | `m.remove {m, cut}` and admin demotions `m.update {…, cut}` use `cut = [seq, opId]` (or `[0]`), always produced with `cutFor(state, memberId)`                                                                                                                                                   |
| **Handshake shapes**         | `hi1 {t, v, tm, e, cm}` · `hi2 {t, e, x}` · `hi3 {t, x}`. `x` is the sealed inner `{id, mc, sg}` / `{id, mc, nn, join?, sg}`. The transport moves frames as opaque bytes and never parses them                                                                                                   |
| **`SyncSession.safetyCode`** | Six digits, set once the session is open, equal on both phones. Show it during a join for the two people to compare. There is no other safety-code API (the old `ids.safetyCode` is gone)                                                                                                        |
| **Replica `flush(now)`**     | Call it (or `SyncSession.tick(now)`) periodically: it folds deferred rebuilds. `data()` flushes on read                                                                                                                                                                                          |
| **Rotation advice**          | Show `replica.rotationAdvised` to every member, and the rotate action to admins ("a join raced; rotate the key"). Admin replicas auto-rotate (`autoRotate`, default on). `state.wrapEvidence` lists suspicious ops by author                                                                     |
| **Handshake deadline**       | Pass `now` to `initiate` (or the first `receive` sets it) and call `tick(now)` periodically. A handshake past 30 s closes with `timeout`                                                                                                                                                         |

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

## 15. Decisions (PM decision 2026-10-07, owner to confirm)

The owner was away. The PM took the recommended default for each open
question, and the code implements them.

| #   | Question                          | Decision                                                                                                  |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | SMS invite default                | **48 h, single use.** This is the UI default; the protocol allows ≤ 30 days and ≤ 1000 uses               |
| 2   | Who may admit a joiner            | **Any member**, with an admin-signed invite. Admin-only is a per-invite option (`ap:'admin'`)             |
| 3   | Do new members see team history?  | **Yes.** They receive the current epoch key. History before the last rotation needs an explicit `k.share` |
| 4   | Removed or demoted admins         | **No re-promotion.** They rejoin with a new device                                                        |
| 5   | Ownership transfer                | **Not in v1.** The owner key is permanent                                                                 |
| 6   | Large-team notification threshold | **30**                                                                                                    |
| 7   | Guests                            | **Read, share their position and post messages.** No edits to shared records                              |
| —   | Crypto library                    | **noble** (`@noble/curves`, `@noble/hashes`, `@noble/ciphers` 2.4.0, pinned exactly), §4.3                |
