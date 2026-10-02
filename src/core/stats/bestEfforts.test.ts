import { bestEffortTimes } from './bestEfforts';

/** Brute force over every pair (with the same start interpolation) — the oracle. */
function brute(cum: number[], timeS: number[], target: number): number | null {
  let best = Infinity;
  for (let j = 1; j < cum.length; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (cum[j]! - cum[i]! >= target) {
        const startPos = cum[j]! - target;
        const a = cum[i]!;
        const b = cum[i + 1]!;
        const frac = b > a ? (startPos - a) / (b - a) : 0;
        const t0 = timeS[i]! + frac * (timeS[i + 1]! - timeS[i]!);
        const dt = timeS[j]! - t0;
        if (dt > 0) best = Math.min(best, dt);
        break;
      }
    }
  }
  return Number.isFinite(best) ? best : null;
}

describe('bestEffortTimes', () => {
  it('times a constant pace exactly, interpolating inside a step', () => {
    // 10 m every 3 s: 1 km takes 300 s, 25 m takes 7.5 s.
    const cum = Array.from({ length: 200 }, (_, k) => k * 10);
    const timeS = cum.map((_, k) => k * 3);
    expect(bestEffortTimes({ cum, timeS }, [1000, 25])).toEqual([300, 7.5]);
  });

  it('finds the fastest stretch anywhere in the track', () => {
    // 10 m/step; steps take 4 s except a fast middle section at 2 s.
    const n = 300;
    const cum = Array.from({ length: n }, (_, k) => k * 10);
    const timeS: number[] = [0];
    for (let k = 1; k < n; k++) timeS.push(timeS[k - 1]! + (k > 100 && k <= 200 ? 2 : 4));
    const [oneK] = bestEffortTimes({ cum, timeS }, [1000]);
    expect(oneK).toBe(200);
  });

  it('agrees with brute force on an irregular series', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const cum = [0];
    const timeS = [0];
    for (let k = 1; k < 400; k++) {
      cum.push(cum[k - 1]! + rand() * 20);
      timeS.push(timeS[k - 1]! + 1 + rand() * 6);
    }
    for (const target of [50, 400, 1234, 3000]) {
      const [fast] = bestEffortTimes({ cum, timeS }, [target]);
      expect(fast).toBeCloseTo(brute(cum, timeS, target)!, 6);
    }
  });

  it('is null when the track is too short, and for a non-positive target', () => {
    const cum = [0, 10, 20];
    const timeS = [0, 1, 2];
    expect(bestEffortTimes({ cum, timeS }, [100, 0, -5])).toEqual([null, null, null]);
  });

  it('never measures across a break', () => {
    // Two 600 m chains: 1 km fits in neither.
    const cum = [0, 300, 600, 600, 900, 1200];
    const timeS = [0, 100, 200, 300, 400, 500];
    const [oneK, half] = bestEffortTimes({ cum, timeS, breaks: [3] }, [1000, 500]);
    expect(oneK).toBeNull();
    expect(half).toBeCloseTo(500 / 3, 6);
    // Without the break it does.
    expect(bestEffortTimes({ cum, timeS }, [1000])[0]).not.toBeNull();
  });

  it('ignores break indices outside the series', () => {
    const cum = [0, 500, 1000];
    const timeS = [0, 100, 200];
    expect(bestEffortTimes({ cum, timeS, breaks: [0, 9] }, [1000])).toEqual([200]);
  });

  it('handles a flat stretch (zero-length steps) at the start of the window', () => {
    const cum = [0, 0, 0, 500, 1000];
    const timeS = [0, 50, 100, 150, 200];
    expect(bestEffortTimes({ cum, timeS }, [1000])).toEqual([100]);
  });
});
