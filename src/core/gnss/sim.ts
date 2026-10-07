/**
 * Synthetic receiver streams, pure (no fs): a scripted RTK session the app's
 * simulated receiver replays (debug / E2E builds) and the tests parse. Every
 * checksum is computed by `formatNmea`, never typed.
 */
import { formatNmea } from './nmea';

function dm(v: number, degDigits: number): string {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return `${String(d).padStart(degDigits, '0')}${m.toFixed(7).padStart(10, '0')}`;
}

function hms(tod: number): string {
  const h = Math.floor(tod / 3600);
  const m = Math.floor((tod % 3600) / 60);
  const s = tod % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${s.toFixed(2).padStart(5, '0')}`;
}

export interface SynthEpoch {
  tod: number;
  lat: number;
  lon: number;
  quality: number;
  sigma: number;
  ageS: number | null;
  date?: string;
}

/** GGA + RMC + GST for one epoch, as a high-precision u-blox would emit them. */
export function nmeaEpoch(e: SynthEpoch): string {
  const lat = `${dm(e.lat, 2)},${e.lat < 0 ? 'S' : 'N'}`;
  const lon = `${dm(e.lon, 3)},${e.lon < 0 ? 'W' : 'E'}`;
  const t = hms(e.tod);
  const mode =
    e.quality === 4
      ? 'R'
      : e.quality === 5
        ? 'F'
        : e.quality === 2
          ? 'D'
          : e.quality === 0
            ? 'N'
            : 'A';
  const gga = formatNmea(
    `GNGGA,${t},${lat},${lon},${e.quality},14,0.8,52.123,M,-31.456,M,${e.ageS === null ? '' : e.ageS.toFixed(1)},${e.ageS === null ? '' : '0007'}`,
  );
  const rmc = formatNmea(
    `GNRMC,${t},${e.quality === 0 ? 'V' : 'A'},${lat},${lon},0.10,45.0,${e.date ?? '011026'},,,${mode},V`,
  );
  const gst = formatNmea(
    `GNGST,${t},0.5,${e.sigma.toFixed(3)},${e.sigma.toFixed(3)},0.0,${e.sigma.toFixed(3)},${e.sigma.toFixed(3)},${(e.sigma * 1.6).toFixed(3)}`,
  );
  return gga + rmc + gst;
}

/**
 * A scripted RTK session along the Plains of Abraham (Québec City), 1 Hz:
 * autonomous → float (σ 0.2 m) → fixed (σ 0.015 m) → corrections age out
 * (RTK still claimed, age climbs past 60 s) → float → autonomous.
 */
export function quebecRtkSession(): { text: string; epochs: SynthEpoch[] } {
  const epochs: SynthEpoch[] = [];
  const start = 12 * 3600;
  for (let i = 0; i < 150; i++) {
    const lat = 46.803 + i * 0.000004;
    const lon = -71.217 + i * 0.000006;
    let quality = 1;
    let sigma = 2.5;
    let ageS: number | null = null;
    if (i >= 10 && i < 30) {
      quality = 5;
      sigma = 0.2;
      ageS = 1;
    } else if (i >= 30 && i < 80) {
      quality = 4;
      sigma = 0.015;
      ageS = 1;
    } else if (i >= 80 && i < 140) {
      // corrections stopped at i = 80: the receiver keeps "fixed" while the age grows.
      quality = i < 125 ? 4 : 5;
      sigma = i < 125 ? 0.02 : 0.3;
      ageS = i - 79;
    }
    epochs.push({ tod: start + i, lat, lon, quality, sigma, ageS });
  }
  return { text: epochs.map(nmeaEpoch).join(''), epochs };
}
