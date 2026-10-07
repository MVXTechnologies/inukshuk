import type { ViewerTrail } from './viewerInfo';

/**
 * A trail's elevation sampled at `count` evenly spaced axis distances, for
 * the viewer's mini profile (#587). One pass over the points; samples with no
 * altitude nearby are null (a gap in the line).
 */
export function sampleProfile(trail: ViewerTrail, count = 96): (number | null)[] {
  const { axisCumM: cum, elevations, totalM } = trail;
  const n = Math.min(cum.length, elevations.length);
  const out: (number | null)[] = [];
  if (n === 0 || count < 2) return out;
  let i = 0;
  for (let k = 0; k < count; k++) {
    const d = (k / (count - 1)) * totalM;
    while (i < n - 2 && cum[i + 1]! <= d) i++;
    const a = elevations[i];
    const b = elevations[Math.min(i + 1, n - 1)];
    if (a === undefined || b === undefined) {
      out.push(a ?? b ?? null);
      continue;
    }
    const span = cum[Math.min(i + 1, n - 1)]! - cum[i]!;
    const t = span > 0 ? Math.min(1, Math.max(0, (d - cum[i]!) / span)) : 0;
    out.push(a + (b - a) * t);
  }
  return out;
}

/** An SVG path (line, and the area under it) for samples in a `w` × `h` box. */
export function profilePaths(
  samples: readonly (number | null)[],
  w: number,
  h: number,
  pad = 3,
): { line: string; area: string } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of samples) {
    if (v === null) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo) || samples.length < 2 || w <= 0) return { line: '', area: '' };
  if (hi - lo < 1) hi = lo + 1;
  const pts = samples.map((v, k) =>
    v === null
      ? null
      : {
          x: (k / (samples.length - 1)) * w,
          y: pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad),
        },
  );
  let line = '';
  let area = '';
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const seg = run.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
      line += `${seg.join(' ')} `;
      area += `${seg.join(' ')} L${run[run.length - 1]!.x.toFixed(1)} ${h} L${run[0]!.x.toFixed(1)} ${h} Z `;
    }
    run = [];
  };
  for (const p of pts) {
    if (p) run.push(p);
    else flush();
  }
  flush();
  return { line: line.trim(), area: area.trim() };
}
