# `@core/gnss` — external GNSS receiver core (#588, stage 1)

Pure TypeScript: no React Native, no Expo, no I/O. The native transport
(`modules/inukshuk-gnss`: BLE Nordic UART, Android SPP, TCP, later iOS
External Accessory) and the UI come in later stages, after the extension
registry. This folder is everything that can be decided from bytes and a
clock.

## Data flow

```
receiver bytes ──► GnssDemuxer (stream.ts) ──► StreamEvent: nmea | ubx | rtcm3
                                                 │
                         FixAssembler (fix.ts) ◄─┘ ──► GnssFix (one per epoch)
                                                         │
             nextStatus / decideSource (quality.ts) ◄────┤──► chip state, phone-GPS power, fallback
                                                         │
   receiverFrame + planFixOutput (datum.ts) ◄────────────┘──► OutputPlan (method, steps, accuracy)
                         │
                transformFix / OffsetCache ──► Engine (injected: native PROJ on the phone)

caster bytes ──► NtripResponseParser (ntrip.ts) ──► RTCM bytes ──► written to the receiver
                                                     └► GnssDemuxer (optional: count / classify, 1005/1006, 1021+ hints)
```

| File              | Responsibility                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `bytes.ts`        | LE readers/writers (UBX), MSB-first bit reader (RTCM), ASCII/UTF-8/base64                                          |
| `nmea.ts`         | NMEA 0183 checksum + GGA, RMC, GSA, GSV, GST, VTG, ZDA; any talker (GP/GL/GA/GB/BD/GQ/GI/GN)                       |
| `ubx.ts`          | UBX framing (Fletcher-8); NAV-PVT, NAV-HPPOSLLH, NAV-SAT, NAV-STATUS, ACK; CFG-VALSET + `minimalKitConfig`         |
| `rtcm3.ts`        | RTCM 3 framing (CRC-24Q), type classes; 1005/1006 station, 1021/1022 transformation, 1023–1027 system id           |
| `stream.ts`       | `GnssDemuxer`: NMEA + UBX + RTCM over arbitrary chunks; resyncs one byte at a time; never throws; `stats`          |
| `fix.ts`          | `GnssFix` model, `FixAssembler` epoch grouping (UBX preferred over NMEA while NAV-PVT flows), sky view             |
| `quality.ts`      | fix kinds, σ→95 %, quality state machine (stale / lost / stale corrections), `decideSource` (phone GPS standby)    |
| `ntrip.ts`        | NTRIP v1/v2 request bytes (Basic auth), response parser (ICY / HTTP / chunked / sourcetable), GGA policy + builder |
| `sourcetable.ts`  | STR / CAS / NET parsing, mountpoints ranked by distance (RTCM 3 first)                                             |
| `casters.ts`      | correction profiles' frame + epoch, caster presets, RTCM 1021 → information-only hint                              |
| `datum.ts`        | the frame a fix is in, the plan into the project datum (via Convert), engine run, offset cache                     |
| `datumVectors.ts` | the official-tool validation vectors' shared types and planner hook                                                |

## Contracts for the later stages

**Native transport (stage 2)** — owns sockets and threads, nothing else:

- push every received chunk, unmodified and in order, into one `GnssDemuxer`
  per connection; `reset()` it on disconnect;
- feed events to one `FixAssembler`; call `flush()` on disconnect;
- run `nextStatus(prev, null, now)` on a ~1 s timer so silence is noticed;
- UBX kits: write the frames of `minimalKitConfig({ port })` once after
  connecting and wait for `ACK-ACK` (`decodeUbx`) for `CFG-VALSET`;
- NTRIP: write `buildNtripRequest(...)` after connecting, feed every received
  chunk to `NtripResponseParser.push`, write the returned `data` to the
  receiver as-is (BLE: split to the MTU); upload GGA when `ggaDecision` says
  so (the receiver's own GGA line, or `buildGga` for UBX-only kits). A head
  status other than `streaming` ends the session with that reason;
- the TCP/TLS socket, credential storage (secure store), background buffering
  and the 10 Hz throttle live natively.

**State + UI (stage 3)**:

- the chip and status line come from `ExternalStatus` + `GnssFix.accuracy`
  (`basis: 'hdop'` → show "≈"); the frame line from `receiverFrameLabel`
  ("⚠ frame unknown" when the profile declares none, owner decision A5);
- the position source and phone-GPS power come from `decideSource`
  (`phone: 'standby'` = `expo-location` at low accuracy, A9); when
  `switched` is true the recorder starts a new segment;
- output coordinates: `planFixOutput(fix, receiverFrame(fix.kind, profile), projectDatum)`
  once per frame / epoch-day / area, then `OffsetCache.apply` per fix with the
  Convert native engine. A refusal is shown with its message, never worked
  around. `OutputPlan.method`, `.steps`, `.datumAccuracyM` and
  `.validation` are what the "how was this computed" panel shows.

## Datum rules

- Autonomous / SBAS fixes are WGS 84 (broadcast). RTK / DGPS fixes are in
  the correction profile's frame; RTCM 1021+ messages are shown, never applied.
- Every datum change is a Convert plan (`@core/convert/graph`): only
  operations validated against NRCan TRX / GPS·H, NOAA NCAT, etc. No
  transformation is implemented here.
- The one modelling step this module adds: WGS 84 ≡ ITRF2020 at the
  observation epoch (and back), as an explicit step carrying the EPSG
  ensemble accuracy of WGS 84 (2 m), flagged amber. Convert hides WGS 84 ↔
  ITRF on purpose; a GNSS fix needs it.
- Outside a validated route the plan is refused with Convert's reason
  (e.g. NAD83(2011) → WGS 84 today, or ITRF outside Canada → NAD83(CSRS)).

## Datum validation vectors

`fixtures/datum-vectors.json`, gated by `datumVectors.test.ts` (always) and
`datumVectors.host.test.ts` (host PROJ, via `modules/inukshuk-proj/tests/run-host.sh`
in the native-build CI job). Each vector is a GNSS scenario with:
the official answer and its source/date, the exact pipeline `datum.ts` must
plan (a change fails), and PROJ 9.8.1's frozen result on it (must agree with
the official answer within the tolerance; the host run must reproduce it to
1e-6 m).

| Vector                  | Scenario                                                     | Official source              |
| ----------------------- | ------------------------------------------------------------ | ---------------------------- |
| `qc-mrnf-wgs84`         | MRNF RTK, NAD83(CSRS) 1997.0 → ITRF2020 @ 2026.75 (→ WGS 84) | NRCan TRX (mark 93K2005)     |
| `qc-mrnf-csrs2010`      | MRNF RTK → NAD83(CSRS) 2010.0                                | NRCan TRX (93K2005)          |
| `qc-mrnf-cgvd2013`      | MRNF RTK h → CGVD2013 (CGG2013a)                             | NRCan GPS·H                  |
| `mtl-polaris-csrs2010`  | ITRF2014 current epoch → NAD83(CSRS) 2010.0                  | NRCan TRX (75K0139, inverse) |
| `van-itrf2020-csrs2010` | ITRF2020 current epoch → NAD83(CSRS) 2010.0                  | NRCan TRX (B326595, inverse) |
| `den-rtn-nad83-1986`    | US RTN NAD83(2011) → NAD83(1986)                             | NOAA NCAT (NADCON 5.0)       |

The TRX values are the TRX answers frozen in `@core/convert/fixtures/reference.json`
(2026-10-05), recombined into GNSS scenarios: TRX's calc service returned
HTTP 500 throughout 2026-10-07. GPS·H and NCAT were queried on 2026-10-07.
To regenerate: plan each scenario with `datum.ts`, query the tool, run the
pipeline with pyproj 3.8.0 / PROJ 9.8.1 and the PROJ-data grids.

## Fixtures

Captures and their licences: `fixtures/SOURCES.md` (gpsd BSD-2-Clause,
pyubx2 BSD-3-Clause). Synthetic streams (Québec City RTK session, UBX frames)
are generated in `testUtils.ts` with computed checksums.
