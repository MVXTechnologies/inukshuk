/** Test-only activity fixtures shared by the activityFiles suites — never imported by the app. */
import { buildSimpleFit } from '@core/geo/fit/testUtils';

export const T0 = Date.UTC(2026, 8, 12, 13, 0, 0);
export const fitBytes = (sport?: number) =>
  buildSimpleFit(
    [
      { lat: 46.8, lon: -71.2, timeMs: T0, altM: 50 },
      { lat: 46.801, lon: -71.2, timeMs: T0 + 30_000, altM: 52 },
    ],
    { sport },
  );

export const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="StravaGPX"><metadata><time>2026-09-12T13:00:00Z</time></metadata>
<trk><name>Morning Run</name><type>running</type><trkseg>
<trkpt lat="46.8" lon="-71.2"><time>2026-09-12T13:00:00Z</time></trkpt>
<trkpt lat="46.801" lon="-71.2"><time>2026-09-12T13:00:30Z</time></trkpt>
</trkseg></trk><wpt lat="46.8" lon="-71.2"><name>Start</name></wpt></gpx>`;

export const TCX = `<?xml version="1.0"?><TrainingCenterDatabase><Activities>
<Activity Sport="Biking"><Id>2026-09-12T13:00:00Z</Id><Lap><Track>
<Trackpoint><Time>2026-09-12T13:00:00Z</Time><Position><LatitudeDegrees>46.8</LatitudeDegrees><LongitudeDegrees>-71.2</LongitudeDegrees></Position></Trackpoint>
<Trackpoint><Time>2026-09-12T13:01:00Z</Time><Position><LatitudeDegrees>46.81</LatitudeDegrees><LongitudeDegrees>-71.2</LongitudeDegrees></Position></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
