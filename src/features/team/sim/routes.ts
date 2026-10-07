/**
 * Where the simulated teammates walk (demo builds only): along the team's
 * shared trails or the Library's trails near me, else the Mont-Sainte-Anne
 * summit trail (the demo fixture). Positions advance at a walking pace along
 * the route, back and forth. Pure.
 */
import { decodePolyline } from '@core/teamui/shares';

/** Mont-Sainte-Anne, sentier du sommet (the demo trail), `[lng, lat]`. */
export const MSA_TRAIL: [number, number][] =
  decodePolyline(
    '}fi~Gl}woLe@y@SzAu@lA{@a@aA]y@_@g@fAa@rAWdB[xAa@@c@Ce@fBi@nAi@`AQhAq@jAEvA[bA{@c@w@d@i@v@e@hAo@dAy@V{@NsAPw@|@_ACy@A@jAL|AGzAY`Bg@bAo@`AcAd@e@hAYtASvAKbBYjAm@h@cATObBBhA[pB{@@i@f@_Al@}@AaAFy@d@HxAy@?m@Pa@x@{@d@cAM}@\\q@v@WnAo@lAWxBF~AS|Ac@dAu@\\]bAJvAF|AHjBLrANpAj@bAb@zARvARzAR|AJxADjB[vAMxBA~ADr@E}ADmBVoBLiBKyAO{AS}AQwASwAs@oA]kAMsAKeBG}AI{AHyAd@]n@y@\\qAD{AAoBn@wAZ{Af@cAv@m@~@?`AMx@g@Ty@|@DVs@NeAbAO~@Ax@?|@w@l@[~@OZbA^^f@`@f@PT\\f@c@fAG`ABz@Wr@q@L_BA}AE{ALkBdA?fA?fAEfA\\x@Dv@g@d@kALaBa@yAM_B`@iA^kANsA@{AQqAFuARsAHuAx@kANyA?oALkADwAp@kAPiAh@aAh@oAd@gBb@B`@AZyAVeB`@sAf@gAx@^`A\\z@`@t@mAR{Ad@x@',
  ) ?? [];

const R = 6_371_000;
export function metres(a: readonly [number, number], b: readonly [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLength(line: readonly (readonly [number, number])[]): number {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += metres(line[i - 1]!, line[i]!);
  return d;
}

/** The point `d` metres along a line, going back and forth (ping-pong) past its ends. */
export function pointAlong(
  line: readonly (readonly [number, number])[],
  d: number,
): [number, number] {
  const len = lineLength(line);
  if (line.length === 0) return [0, 0];
  if (len === 0) return [line[0]![0], line[0]![1]];
  const m = ((d % (2 * len)) + 2 * len) % (2 * len);
  let left = m <= len ? m : 2 * len - m;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = metres(a, b);
    if (left <= seg) {
      const t = seg === 0 ? 0 : left / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= seg;
  }
  const last = line[line.length - 1]!;
  return [last[0], last[1]];
}

/** One step of `step` metres from `from` straight toward `to` (arrives when closer). */
export function stepToward(
  from: readonly [number, number],
  to: readonly [number, number],
  step: number,
): [number, number] {
  const d = metres(from, to);
  if (d <= step || d === 0) return [to[0], to[1]];
  const t = step / d;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/** Lines within `radiusM` of `here` (any vertex), longest first; MSA when none. */
export function routesNear(
  here: readonly [number, number] | null,
  lines: readonly (readonly [number, number])[][],
  radiusM = 5_000,
): (readonly [number, number])[][] {
  const near =
    here === null
      ? []
      : lines.filter(
          (l) => l.length > 1 && l.some((p, i) => i % 5 === 0 && metres(p, here) <= radiusM),
        );
  return near.length > 0 ? [...near].sort((a, b) => lineLength(b) - lineLength(a)) : [MSA_TRAIL];
}
