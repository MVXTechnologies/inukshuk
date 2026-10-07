# GNSS fixtures — sources and licences

Real-world captures, byte-exact as published (prettier-ignored). The test helper
`loadCapture` strips the leading `# …` comment header the gpsd logs carry.

## gpsd regression logs — BSD-2-Clause

From `test/daemon/` of https://gitlab.com/gpsd/gpsd (master, fetched 2026-10-07).
Licence: the GPSD project's BSD-2-Clause (`COPYING`, "SPDX short identifier:
BSD-2-Clause"; several files repeat it in their header). Copyright the GPSD
project and the submitters named in each file header.

| File | What it is | Used for |
| --- | --- | --- |
| `gpsd/nmea-rtk.log` | Trimble NMEA, DGPS then RTK fixed (quality 4), GP + GN talkers, 2020-03-18 | GGA/RMC parsing, RTK assembly |
| `gpsd/neo-m8n.log` | u-blox NEO-M8N NMEA, GPS + GLONASS GSV, GN GSA/GLL/VTG | multi-constellation talkers |
| `gpsd/polarx2.log` | Septentrio PolarRx2: GST, ZDA, GSA, GNS, GBS | GST / ZDA parsing |
| `gpsd/skytraq-PX1172RH_DS.log` | SkyTraq PX1172RH RTK board: GA/GB GSV, GN ZDA, PSTI | Galileo / BeiDou talkers |
| `gpsd/ntrip_sourcetable.log` | Real NTRIP 2 answer from the SAPOS caster (2017-12-15) | response parser, sourcetable |
| `gpsd/rtcm3.log` | RTCM 3.0 standard examples (1029 text, 1005 station) | CRC-24Q, 1005 decode |
| `gpsd/rtcm3.bndm.log` | ORGN network stream, Bend OR (1004/1012 obs, 1006, 1008, 1033…) | framing, 1006 decode, fuzzing |
| `gpsd/rtcm3_102x135.log` | BEV Austria transformation messages 1021 / 1023 / 1025 | datum-hint decode |

Expected decoded values in the tests come from gpsd's own `.chk` files for the
same logs.

## pyubx2 test logs — BSD-3-Clause

From `tests/` of https://github.com/semuconsulting/pyubx2 (master, fetched
2026-10-07). Copyright (c) 2020, semuadin (Steve Smith). BSD 3-Clause License:

> Redistribution and use in source and binary forms, with or without modification,
> are permitted provided that the following conditions are met: (1) Redistributions
> of source code must retain the above copyright notice, this list of conditions and
> the following disclaimer. (2) Redistributions in binary form must reproduce the
> above copyright notice, this list of conditions and the following disclaimer in the
> documentation and/or other materials provided with the distribution. (3) Neither the
> name of the copyright holder nor the names of its contributors may be used to
> endorse or promote products derived from this software without specific prior
> written permission. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
> CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES … ARE DISCLAIMED.

| File | What it is | Used for |
| --- | --- | --- |
| `pyubx2/pygpsdata-NAV.log` | u-blox NAV-* messages incl. NAV-PVT, NAV-SAT (43 SVs), NAV-STATUS | UBX decode vs pyubx2's expected strings |
| `pyubx2/pygpsdata-NAVHPPOS.log` | NAV-HPPOSLLH + NAV-HPPOSECEF | high-precision position |
| `pyubx2/pygpsdata-MIXED-RTCM3.log` | UBX + NMEA + RTCM 3 interleaved | demuxer, chunking, fuzzing |

The CFG-VALSET payload test vector and the configuration key ids are checked
against pyubx2's `tests/test_configdb.py` and `ubxtypes_configdb.py`.

## datum-vectors.json — official geodetic tools

Generated, not captured; see `../README.md` ("Datum validation vectors").
