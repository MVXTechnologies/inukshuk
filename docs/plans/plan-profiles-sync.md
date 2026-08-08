# Profiles + paid cloud sync ($2.99/mo) — design package

Feature-lead design, 2026-08-08. Grounded in the codebase at `main`/`map-chrome-batch`
(v1.3.0, Expo SDK 56 / RN 0.85). Research verified Aug 2026 (store rules, library
status, PocketBase/Litestream versions).

## 0. What we're building on (codebase facts)

- **All user data is files + one JSON index.** `src/data/storage.ts`: `maps/<id>.pdf`,
  `tracks/<id>.gpx`, `photos/<id>.<ext>`, `library.json` (atomic staged writes,
  `.corrupt` forensics). Ids are `nanoid(12)` (`newId()`).
- **`library.json` schema is versioned** (`LIBRARY_SCHEMA_VERSION = 4`, migration
  ladder in `src/core/library/migrations.ts`). Adding sync metadata = schema v5, a
  well-trodden path.
- **The sync scope is already enumerated** by `src/core/export/archivePlan.ts`
  (Download-your-data ZIP): every map PDF, trail GPX, note photo, plus `library.json`
  (folders, bundles, waypoints, categories). Sync v1 = that list **minus map PDFs**
  (tens of MB each; owner asked for traces + photos — PDFs are a later milestone).
- **No mutation timestamps today.** `TrackSummary`/`MapDocument`/`Folder` have
  `startedAt`/`importedAt`/`createdAt` but no `updatedAt`, and deletes are hard
  deletes. Sync needs both added (M0).
- **Integration patterns to reuse:** `stravaStore` + `@lib/strava` +
  `StravaSection.tsx` (connect/disconnect row, "not configured in this build"
  degradation via `app.config.ts` `extra.*` env keys, lines 199-210); the
  error-report queue's offline persistence + exponential backoff
  (`src/data/errorQueue.ts`, `src/core/errors/`).
- **Gap to fix, not copy:** Strava tokens persist in _plaintext_ `strava.json`.
  Account tokens must use `expo-secure-store` (not currently a dependency).

---

## 1. Account model & auth

**Auth method: email + password only for v1.** App Store guideline 4.8 (current
text) only forces a privacy-preserving alternative when you offer _third-party_
login (Google/Facebook/etc.); an app "exclusively using your company's own account
system" is exempt. So no Sign-in-with-Apple obligation. If social login is ever
added, add SIWA at the same time (PocketBase supports Apple OAuth incl. generating
the rotating client secret in its admin UI). Passkeys: revisit post-v1; email+password

- reset flow is the lowest-friction baseline PocketBase gives us for free.

**Profile contents (deliberately minimal):** email (verified), display name, avatar
image, created date, subscription entitlement state. Nothing else — no analytics,
no location history server-side beyond the synced tracks themselves. Data lives on
the owner's NAS in Québec: "your data stays in Canada, on hardware we own" is a
marketable privacy posture for a hiking app.

**GDPR / Québec Law 25 basics (paid consumer service):**

- Designate a privacy officer (default: the owner; publish contact on the privacy
  policy page) and update the privacy policy before M1 ships (also the ASC privacy
  URL — already a pending item from the repo migration).
- Rights: access + portability (the existing Download-your-data ZIP already
  satisfies this), rectification (profile editing), **deletion** — needs an
  in-app "Delete account" that wipes server data. Apple guideline 5.1.1(v) makes
  in-app account deletion _mandatory_ anyway.
- Consent: sync is opt-in by nature (paid tier); collect only what the feature
  needs. Breach notification: Law 25 requires notifying the CAI + affected users
  for serious incidents — the backup/security section below is the mitigation.

---

## 2. Backend architecture (NAS-hosted)

**Recommended stack: PocketBase, one Docker container.** (v0.39.x, Aug 2026:
single Go binary, SQLite WAL, built-in email/password auth + verification + reset,
file storage on local FS or S3, JS hooks, admin UI, scheduled backups.) It covers
accounts, file endpoints, and per-user access rules out of the box; claims 10k+
realtime connections on a $4 VPS — hundreds of users is trivial for any NAS.
Alternatives rejected: self-hosted Supabase (~13 containers, 4-8GB RAM, solo-owner
upgrade burden — disproportionate), custom Node/Fastify+SQLite (sound, but
re-implements PocketBase's hardest 20%: auth flows, email, file ACLs, admin UI).
Caveats accepted: PocketBase is pre-1.0 (pin the version, read changelogs before
upgrading) and single-writer SQLite (irrelevant at this scale).

**Collections** (all with owner-only API rules `user = @request.auth.id`):

- `users` (PB auth collection) + profile fields (name, avatar file).
- `tracks`: id (client nanoid), name, summary JSON (stats, category, folderId,
  notes sans photo bytes), GPX **file field**, `updatedAt`, `deleted` (tombstone).
- `photos`: id, trackId/noteId, image file field, `updatedAt`, `deleted`.
- `library_meta`: one record per user — folders, bundles, waypoints, custom
  categories as JSON (small, changes rarely; synced as a whole with LWW).
- `entitlements`: userId, state machine field, store transaction key (M4).

**Sync protocol — LWW, no vector clocks.** This is a single-user, few-devices
problem; per-item last-write-wins on `updatedAt` (client clock, server tiebreak)
is correct enough, and losing a race means losing one rename, not a track: GPX
files are effectively immutable after save (trim rewrites are rare and versioned
by `updatedAt` too). Vector clocks/CRDTs are unjustified complexity here.

- **Push:** outbox of dirty item ids (persisted in `library.json` v5); upload
  changed records + files. Delta = per-item granularity; a GPX or photo uploads
  whole (they're single files, no chunk-diffing — a 20k-point GPX is ~2-5MB
  deflated, fine).
- **Pull:** `GET /api/collections/tracks/records?filter=updated>{cursor}` — PB's
  built-in `updated` field is the server-side cursor; tombstones propagate deletes.
- **Conflict rule:** newer `updatedAt` wins per item; on exact tie, server copy
  wins. Deletion vs edit: tombstone wins if newer, else the edit resurrects.
  All of this is pure logic → `src/core/sync/` with unit tests.

**Client architecture:** pure `src/core/sync/` (outbox reducer, merge/LWW,
cursor math — co-located tests, coverage-gated); `src/data/syncClient.ts`
(fetch + file upload against PB, backoff modeled on `errorQueue`); `src/state/`
`accountStore.ts` + `syncStore.ts` (Zustand, mirroring `stravaStore` shape);
`src/features/settings/CloudSection.tsx` (mirroring `StravaSection`). Config via
`app.config.ts` `extra.cloudSyncUrl` (env `CLOUD_SYNC_URL`) — unset ⇒ the whole
feature is invisible, exactly like the Strava "not configured in this build" path.
That `extra` key **is** the feature flag.

**Offline / NAS-unreachable behavior:** sync is strictly opportunistic — triggered
on app foreground, after a track save, and manually ("Sync now" row). Failures
queue in the outbox and back off exponentially (30s → 1h, same policy as error
reporting); the app never blocks on the network (it's an offline trail app —
this is non-negotiable). `offline-only` mode (`settingsStore`) also suspends sync.
A device that can't reach the NAS for a month just syncs a bigger delta later.

**TLS / domain:** `inukshuk.mvxtechnologies.com` → the NAS. Two viable setups:
(a) **Cloudflare Tunnel** (`cloudflared` container): zero open ports, works behind
CGNAT, free — requires moving `mvxtechnologies.com` DNS to Cloudflare;
(b) port-forward 443 + Synology DSM reverse proxy + built-in Let's Encrypt
(needs port 80 open for HTTP-01 renewal and a stable public IP). Tailscale Funnel
is eliminated (no custom domains). Recommendation: **(a)**.

**Backup story (this is people's paid data — treat as a hard requirement):**
PocketBase's built-in scheduled backups (zips `pb_data`) to an S3 target
(Backblaze B2, ~pennies/mo) **plus** Litestream (v0.5.x, actively maintained)
continuously replicating the SQLite DB to B2 for point-in-time recovery.
Synology snapshots/Hyper Backup as belt-and-suspenders. Test a restore before M2
ships — an untested backup is not a backup.

---

## 3. Payments

**Store rules (verified Aug 2026):** digital subscription ⇒ in-app purchase.
Effective cut is **15% on both stores**: Apple via Small Business Program
(<$1M/yr — must enroll in ASC, not automatic; subs also drop to 15% after year 1
regardless) and Google's flat 15% for auto-renewing subscriptions. US
external-link checkout exists post-Epic rulings but is legally in flux (9th Cir.
says Apple may charge a fee, SCOTUS pending; Google's US alt-billing rolls out
2026 with 9-20%+5% schedules) — **do not architect around it**; revisit in 2027.

**Economics at $2.99/mo:** net **≈ $2.54/subscriber/mo** at 15% (before local
taxes the stores withhold in some countries). $2.99 is a valid Apple price point;
comparable CAD price CA$3.99 (set per-region deliberately in ASC; Play allows
arbitrary per-country prices). Marginal hosting cost ≈ $0 (owner's NAS + a few
cents of B2) — 10 subscribers already covers backup + domain costs.

**Client library & validation — two credible paths:**

- **A. RevenueCat** (`react-native-purchases`, official Expo dev-build support):
  free until $2,500 MTR/mo (**≈ 835 subscribers** at $2.99), then 1% of gross.
  It owns receipt validation, store webhooks, grace/retry state, restore edge
  cases; the NAS just consumes one RevenueCat webhook to set
  `entitlements.state`. Lock-in is modest (entitlement checks are a thin wrapper).
- **B. Raw expo-iap + self-hosted validation.** Note: hyochan's `react-native-iap`
  and `expo-iap` repos were archived Aug 2026 — development continues in the
  OpenIAP monorepo, npm names unchanged; expo-iap has known transaction-handling
  rough edges. Server side: `@apple/app-store-server-library` (App Store Server
  API v2 + Notifications V2 — needs an IAP .p8 key, and the webhook is another
  public HTTPS endpoint on the NAS) and `googleapis`
  `purchases.subscriptionsv2.get` + RTDN via Cloud Pub/Sub (and purchases must be
  acknowledged within 3 days or Google auto-refunds). This is a PB-hooks-won't-cut-it
  workload: it means a small Node sidecar service + weeks of edge-case work.

**Recommendation: A (RevenueCat).** The self-hosting principle is about _user
data_; purchase receipts already transit Apple/Google. RevenueCat sees purchase
metadata only (configure no ads/attribution), costs $0 until ~835 subs, and
replaces the entire hardest milestone. Path B remains open later (OpenIAP is the
escape hatch) — the app-side entitlement gate doesn't change.

**Subscription state machine (server, regardless of path):**
`active` → `grace` (entitled; Apple grace 16 days — opt in via ASC; Google grace
per base plan) → `billing_retry`/`on_hold` (NOT entitled; up to ~60 days) →
`expired`; plus `canceled_active_until_expiry`, `revoked` (refund ⇒ cut now),
and Android `paused`. Key on Apple `originalTransactionId` / Google
`purchaseToken` stored on the user record; define a takeover policy when one
store identity is restored into a second account (recommend: move entitlement to
the most recent account, notify the old one).

**Gating UX ("free app, paid sync"):** the app never paywalls existing features.
Settings → "Inukshuk Cloud" section: create account (free — profile only),
then "Enable sync — $2.99/month" opens the paywall sheet (price, what syncs,
subscribe / **Restore purchases** [App Review requires it] / manage subscription
link). Lapsed subscription ⇒ sync pauses, **local data untouched, server copy
retained 90 days** (state in the section row, e.g. "Sync paused — billing issue").
Grace period keeps syncing.

---

## 4. Security

- **Device tokens:** PB auth token + refresh in `expo-secure-store`
  (Keychain/Keystore) — new dependency; do _not_ copy the plaintext `strava.json`
  pattern. Migrate Strava tokens into secure-store opportunistically while at it.
- **In transit:** TLS everywhere (HSTS at the proxy); certificate via LE/Cloudflare.
  App refuses plain http except a `__DEV__`/staging override for the E2E loopback.
- **At rest:** NAS volume for `pb_data` on an encrypted Synology shared folder;
  B2 backups encrypted (Litestream supports encryption; PB backup zips go to a
  private bucket). Argon2/bcrypt password hashing is PB built-in.
- **Photo/GPX privacy:** PB _protected_ file fields — files served only with
  short-lived file tokens under the owner-only collection rules; never public
  URLs. No EXIF stripping needed (photos round-trip to the same user only).
- **Not doing:** end-to-end encryption (would break server-side nothing anyway —
  the server does no processing — but adds key-loss = data-loss UX; note it as a
  possible future "paranoid mode"). Rate-limit auth endpoints (PB built-in) and
  keep the admin UI off the public hostname (Tunnel route only to `/api/*`).

---

## 5. Milestones (each shippable alone, gated by `extra.cloudSyncUrl`)

**M0 — sync-ready data model (no network).** `library.json` schema v5:
`updatedAt` on tracks/maps/folders/waypoints (stamped in every `libraryStore`
mutation), tombstone list, persisted outbox. Pure logic in `src/core/sync/` +
migration 4→5 in `migrations.ts`. _Tests:_ unit only (migration ladder totality,
outbox reducer, LWW merge table — including tie, delete-vs-edit, clock-skew cases).

**M1 — accounts.** PB deployed on NAS + domain/TLS; signup/login/verify/reset,
profile (name + avatar), account deletion, secure token storage,
`CloudSection.tsx` behind the flag. _Tests:_ core-pure validators unit-tested;
**CI/staging runs the real PocketBase binary on localhost** (single binary — start
it in the Maestro job, seed a user, point `CLOUD_SYNC_URL` at loopback; precedent:
the offline-pack transient loopback server). Maestro flow: create account → kill
app → relaunch → still signed in → delete account.

**M2 — one-way backup (push).** Upload tracks + notes + photos + library_meta;
sync-status UI (last synced, N pending); backoff + offline queueing. Restore-all
onto a fresh install (pull-everything bootstrap — read-only, no merge). _Tests:_
core merge/cursor units; Maestro: record (gpsFilter ≤ 40 m/s in flows) → save →
sync → wipe app storage → sign in → track reappears. Backup restore drill on NAS.

**M3 — two-way sync.** Full pull with LWW + tombstones, two-device convergence,
conflict handling, `offline-only` interaction. _Tests:_ property-style core tests
(two replicas, random op interleavings converge); E2E with two sequential app
states against one PB instance in CI.

**M4 — payments.** RevenueCat (pending owner decision) + entitlement gating,
paywall + restore + manage, grace/hold states, server webhook → `entitlements`.
_Tests:_ store-sandbox manual matrix (subscribe, cancel, grace, refund, restore,
second device); entitlement state machine unit-tested in core; CI uses a fake
entitlement provider (flag-injected) since sandbox IAP can't run in Maestro.

**M5 (later, optional):** map-PDF sync (large blobs, wifi-only), Apple/passkey
login, e2ee mode.

Rollout: M0 rides any release invisibly; M1-M3 can ship to production dark (flag
unset) or as a free beta ("Cloud beta — free while in testing", which also builds
goodwill and QA before money is involved); M4 flips on billing.

---

## 6. Owner decisions needed (short list)

1. **NAS runtime:** What make/model, and can it run Docker/Container Manager
   (Synology DSM 7+, x86)? — If it can't run containers, PocketBase still runs as
   a bare binary; if it's ARM/old, we should know now. _Need the model number._
2. **Exposure:** Move `mvxtechnologies.com` DNS to Cloudflare and use a Tunnel
   (zero open ports — **recommended**), or port-forward 443/80 with DSM's
   built-in reverse proxy + Let's Encrypt (needs stable public IP)?
3. **Billing:** RevenueCat free tier (**recommended**; $0 until ~835 subs, skips
   building receipt validation) or raw expo-iap + self-hosted Apple/Google
   validation on the NAS (max independence, ~weeks more work)?
4. **Backend:** PocketBase (**recommended**) or custom Node/Fastify+SQLite?
   (Only pick custom if you enjoy owning auth/email/file-ACL code.)
5. **Email sending:** Accounts need verification/reset emails — managed SMTP
   (Brevo/Resend free tier, **recommended**) or the NAS/mvxtechnologies mail
   setup?
6. **Offsite backup:** Backblaze B2 bucket (~$1/mo, **recommended**) — yes/no?
   (No offsite backup = paid users' data lives on one box in one house.)
7. **Pricing regions:** $2.99 USD / CA$3.99 — confirm, and whether to limit
   availability to CA/US/EU initially (fewer tax regimes — **recommended**).
8. **Policy updates (owner-only paperwork):** update privacy policy + ASC privacy
   URL for accounts/sync (name a privacy officer per Law 25), enroll in Apple's
   Small Business Program, and set refund policy = defer to store-managed refunds
   (**recommended**; refunds revoke entitlement automatically)?
9. **Scope check:** map PDFs excluded from sync v1 (traces + photos only,
   **recommended**) — agreed?
