# Garmin Connect Developer Program — application package (2026-08-04)

Ready-to-submit application for Activity API access for Inukshuk. Companion to
`2026-08-03-garmin-sync-research.md` (Phase 2 of the sync plan).

## 1. Submission route & current status

- **Official route**: a single web form —
  **https://www.garmin.com/en-US/forms/GarminConnectDeveloperAccess/**
  (linked from https://developer.garmin.com/gc-developer-program/). No portal
  self-signup, no fee. Historical promise: application status confirmed
  **within 2 business days**, then portal access + an integration call; "a
  typical integration takes between 1 and 4 weeks."
- **Status verified 2026-08-04**: the form is **down**. The live page serves a
  Contentful copy block `System Maintenance — Garmin Connect Developer
Program` / _"Stay tuned for more updates on the program"_ (start date
  2026-03-25, last updated 2026-05-08). Community reports (Garmin forums
  thread 434761; open-wearables #1117, June 2026) say new sign-ups have been
  on hold for months and emails go unanswered.
- **Interim routes while the form is down** (do both):
  1. Email **connect-support@developer.garmin.com** with the answers in §2
     rewritten as prose (template in §4).
  2. The developer contact form: https://www.garmin.com/en-US/forms/developercontactus/
     (and the wellness-partner form the Activity API page links:
     https://www.garmin.com/forms/wellnesspartner/).
- **Eligibility caveat**: the program FAQ says it is "only for business use" —
  apply as a sole proprietorship (self-employed individual is a legal business
  form in Quebec; no registration needed when operating under your own name).
- **Re-check cadence**: reload the access form monthly; it renders the full
  form again (not the maintenance block) when reopened. Fallback if it never
  reopens for indies: aggregators (Terra, Open Wearables) — paid, per-user.

## 2. Draft answers — every form field

Field list extracted from the last live form snapshot (Wayback, 2025-12-04).
`*` = required on the form. Items marked **[FILL]** need your input.

### Company Information

| Field                                                      | Answer                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Company name * (≤60 chars)                                 | `Marc-André Vigneault (sole proprietor) — Inukshuk`                                                                                               |
| Contact name *                                             | `Marc-André Vigneault`                                                                                                                            |
| Email address *                                            | `marcandre.vigneault.96@gmail.com` **[verify — task brief spelled it `marc-andre.vigneault.96@gmail.com`; use the mailbox you actually control]** |
| Job Title *                                                | `Founder / Software Developer`                                                                                                                    |
| Contact phone number (include country code) *              | `+1` **[FILL — your number]**                                                                                                                     |
| Address *                                                  | **[FILL — street address]**                                                                                                                       |
| City *                                                     | `Havre-Saint-Pierre`                                                                                                                              |
| Country & State/Province/Region *                          | `Canada` / `Quebec`                                                                                                                               |
| Postal Code *                                              | `G0G 1P0` **[verify]**                                                                                                                            |
| Primary Sales Region *                                     | `AMERICAS`                                                                                                                                        |
| Technical Support Language Preference *                    | `English`                                                                                                                                         |
| Company website *                                          | **[GAP — see §3]** suggest `https://github.com/<user>/inukshuk` or a GitHub Pages landing                                                         |
| Link to Privacy Statement/Policy * ("a legal requirement") | **[GAP — see §3]**                                                                                                                                |

### Client or Third-Party Integration

| Field                                                                      | Answer    |
| -------------------------------------------------------------------------- | --------- |
| Do you intend to integrate on behalf of a client or third-party company? * | `No`      |
| If yes, legal name and description                                         | _(blank)_ |

### Subcontractor Information

| Field                                                             | Answer        |
| ----------------------------------------------------------------- | ------------- |
| Will you utilize a subcontractor for your intended application? * | `No`          |
| Subcontractor name/title/address fields                           | _(all blank)_ |

### General Program

**How do you plan to use the Garmin Connect Developer Program? *** (paste):

> Inukshuk is an offline trail-navigation app for iOS and Android (React
> Native / Expo). Hikers load georeferenced PDF maps, navigate offline, and
> record GPX tracks into a personal on-device trail library. We want the
> Activity API so a user who also records hikes, trail runs, or ski tours on
> their Garmin watch can connect their own Garmin account (OAuth 2.0 PKCE)
> and have their own activities appear in their personal library — pulling
> the GPX/FIT activity file after a push notification to our registered
> callback. Strictly user-initiated, single-user-scope sync: each user
> accesses only their own activities, can disconnect at any time, and files
> are stored only on the user's device. No analytics, no aggregation, no
> resale, and no wellness/health data beyond the activity files themselves.
> The app is currently distributed via Google Play (internal track) and
> Apple TestFlight, heading to public store release.

| Field                                                                                         | Answer                                                                                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Do you intend to offer the data and/or share it with other platforms or services? *           | `No`                                                                                                           |
| If so, specify data types and third-party platforms                                           | `N/A — activity files are delivered only to the owning user's device; nothing is shared with any third party.` |
| Can Garmin or a Garmin Distributor contact you to discuss potential business opportunities? * | `Yes`                                                                                                          |
| Have you already been in contact with Garmin or a Garmin Distributor? *                       | `No`                                                                                                           |
| If yes, name of contact                                                                       | _(blank)_                                                                                                      |
| Are you currently integrated with other device companies (e.g. Fitbit, Polar, Apple)? *       | `No`                                                                                                           |
| How many end users/members are on your platform? *                                            | `Under 10 (private beta); projecting low hundreds in year one after public launch.`                            |
| Business Services * (checkboxes)                                                              | `Fitness or Outdoor – direct to consumer`                                                                      |
| Reference / Target Customer * (checkboxes)                                                    | `General Consumer`                                                                                             |

## 3. Gaps to close before submitting

1. **Privacy policy URL (required, "legal requirement")** — none published.
   Quick fix: write a short policy (data collected: none server-side; Garmin
   activity data stored on-device only; disconnect revokes tokens) and host it
   on GitHub Pages (`https://<user>.github.io/inukshuk/privacy`). Needed for
   the public Play/App Store listings anyway — do it once, reuse thrice.
2. **Company website (required)** — same GitHub Pages site can serve as a
   one-page product site; a bare repo link is weaker but acceptable.
3. **Business identity** — program is "business use" only. Sole proprietorship
   under your own name is fine in Quebec without registration; consider
   registering a name (Registraire des entreprises, ~$40) only if Garmin
   pushes back.
4. **Webhook callback URL** — the Activity API is push/ping-based; Garmin will
   ask for an HTTPS endpoint during integration. Plan: minimal EAS Hosting
   API route that relays/holds activity notifications (no retention beyond
   relay), per the research doc's Phase 2. Not needed to apply, needed to
   integrate.
5. **Public store listing** — app is internal-track/TestFlight only. Not a
   stated form requirement, but reviewers favor a visible product; the
   GitHub Pages site with screenshots covers this until the public release.
6. **Phone number + street address** — fill in §2.

## 4. Email template (while the form is down)

To: `connect-support@developer.garmin.com`
Subject: `Connect Developer Program access request (Activity API) — Inukshuk`

> Hello, — I'd like to apply for the Garmin Connect Developer Program
> (Activity API). The access request form at
> garmin.com/en-US/forms/GarminConnectDeveloperAccess has shown a system-
> maintenance notice since March; please let me know how to apply in the
> meantime, or when the form will reopen.
>
> Applicant: Marc-André Vigneault, sole proprietor (Founder / Software
> Developer), Havre-Saint-Pierre, Quebec, Canada — [email], [phone].
> Product: Inukshuk — offline trail-navigation app (iOS/Android), Google Play
> internal track + Apple TestFlight today, heading to public release.
> Use case: [paste the §2 use-case paragraph].
> Data handling: on-device storage only; no server-side retention beyond
> webhook relay; user can disconnect anytime; no data shared with third
> parties; no analytics or resale.
> Scale: under 10 users in beta, low hundreds projected in year one.
> Website / privacy policy: [links from §3].
>
> Happy to provide anything else needed for review. Thank you!

## Sources

- Program FAQ: https://developer.garmin.com/gc-developer-program/program-faq/
- Activity API: https://developer.garmin.com/gc-developer-program/activity-api/
- Access form (down): https://www.garmin.com/en-US/forms/GarminConnectDeveloperAccess/
- Form fields: Wayback snapshot 2025-12-04 (`web.archive.org/web/20251204045725/…/GarminConnectDeveloperAccess/`)
- Status reports: forums.garmin.com/developer/connect-iq/f/discussion/434761 ; github.com/the-momentum/open-wearables/issues/1117
