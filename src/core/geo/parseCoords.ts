import type { LatLng } from '@core/models';

/**
 * Coordinate ENTRY: turn whatever a hiker pastes into the "go to" box back
 * into a `LatLng`, or reject it.
 *
 * The three notations people actually copy out of other apps are all
 * accepted, in either hemisphere-letter or signed form:
 *
 * - decimal degrees      `46.8139, -71.2082` · `46.8139° N 71.2082° W`
 * - degrees + minutes    `46 48.834 N, 71 12.492 W` · `46°48.834'N 71°12.492'W`
 * - degrees/min/seconds  `46°48'50.0"N 71°12'29.5"W` · `46 48 50 N, 71 12 29 W`
 *
 * Separators may be a comma, semicolon, slash or plain whitespace; the usual
 * Unicode look-alikes (º ˚ ′ ’ ´ ″ ” and a doubled apostrophe for seconds) are
 * normalised to their ASCII forms first.
 *
 * **It guesses at nothing.** A coordinate you type wrong is worse than one the
 * app refuses, because a silently mis-parsed destination sends you the wrong
 * way in the bush. So the parser is a real grammar, not a pile of regexes, and
 * it rejects: unknown characters, a lone coordinate, three or more of them,
 * minutes/seconds ≥ 60, fractional degrees in front of minutes, a sign AND a
 * hemisphere letter on the same value, two latitude (or two longitude)
 * hemispheres, a hemisphere on only one of the pair, and anything out of the
 * ±90 / ±180 range.
 */

type TokenKind = 'num' | 'deg' | 'min' | 'sec' | 'hemi' | 'sep';

interface Token {
  kind: TokenKind;
  /** Numeric magnitude for 'num'; the letter for 'hemi'. */
  value: number;
  hemi?: 'N' | 'S' | 'E' | 'W';
  /** True when a 'num' token carried a leading minus. */
  negative?: boolean;
}

const NUM_START = /[0-9+-]/;

/** ASCII-fold the degree/prime/double-prime look-alikes and the odd spaces. */
function normalize(input: string): string {
  return (
    input
      .replace(/[\u00BA\u02DA]/g, '\u00B0')
      .replace(/[\u2032\u2019\u00B4`]/g, "'")
      .replace(/[\u2033\u201C\u201D]/g, '"')
      .replace(/''/g, '"')
      // \s already covers NBSP and the other Unicode spaces a paste carries.
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase()
  );
}

/** Split the normalised text into tokens, or `null` on any character we don't know. */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === ' ') {
      i++;
      continue;
    }
    if (NUM_START.test(c)) {
      const m = /^[+-]?\d+(\.\d+)?/.exec(text.slice(i));
      // A bare sign, or a decimal point with no leading digit, is junk.
      if (!m) return null;
      const raw = m[0];
      tokens.push({ kind: 'num', value: Math.abs(Number(raw)), negative: raw.startsWith('-') });
      i += raw.length;
      continue;
    }
    if (c === '°') {
      tokens.push({ kind: 'deg', value: 0 });
      i++;
      continue;
    }
    if (c === "'") {
      tokens.push({ kind: 'min', value: 0 });
      i++;
      continue;
    }
    if (c === '"') {
      tokens.push({ kind: 'sec', value: 0 });
      i++;
      continue;
    }
    if (c === 'N' || c === 'S' || c === 'E' || c === 'W') {
      tokens.push({ kind: 'hemi', value: 0, hemi: c });
      i++;
      continue;
    }
    if (c === ',' || c === ';' || c === '/') {
      tokens.push({ kind: 'sep', value: 0 });
      i++;
      continue;
    }
    return null; // unknown character — reject rather than skip
  }
  return tokens;
}

/**
 * Cut the token stream into exactly two coordinates.
 *
 * An explicit separator wins. Failing that, hemisphere letters delimit the
 * pair (`N 46 W 71` splits before the second letter, `46 N 71 W` after the
 * first). With neither, the only unambiguous reading is an even run of
 * numbers split down the middle — 2 for a DD pair, 4 for DDM, 6 for DMS.
 */
function splitPair(tokens: readonly Token[]): [Token[], Token[]] | null {
  const seps = tokens.flatMap((t, i) => (t.kind === 'sep' ? [i] : []));
  if (seps.length > 1) return null;
  const at = seps[0];
  if (at !== undefined) {
    const left = tokens.slice(0, at);
    const right = tokens.slice(at + 1);
    return left.length > 0 && right.length > 0 ? [left, right] : null;
  }

  const hemis = tokens.flatMap((t, i) => (t.kind === 'hemi' ? [i] : []));
  if (hemis.length === 2) {
    const [first, second] = hemis as [number, number];
    // Leading letters ("N 46 …") start the second coordinate at the second
    // letter; trailing letters ("46 N …") end the first coordinate after it.
    const cut = first === 0 ? second : first + 1;
    const left = tokens.slice(0, cut);
    const right = tokens.slice(cut);
    return left.length > 0 && right.length > 0 ? [left, right] : null;
  }
  if (hemis.length !== 0) return null;

  const numIdx = tokens.flatMap((t, i) => (t.kind === 'num' ? [i] : []));
  if (numIdx.length !== 2 && numIdx.length !== 4 && numIdx.length !== 6) return null;
  const cut = numIdx[numIdx.length / 2];
  if (cut === undefined || cut === 0) return null;
  return [tokens.slice(0, cut), tokens.slice(cut)];
}

interface Component {
  /** Signed decimal degrees. */
  degrees: number;
  hemi: 'N' | 'S' | 'E' | 'W' | null;
}

/**
 * `[HEMI] deg [°] [ min ['] [ sec ["] ] ] [HEMI]` — the whole token run must be
 * consumed, so a stray symbol anywhere rejects the input.
 */
function parseComponent(tokens: readonly Token[]): Component | null {
  let i = 0;
  let hemi: Component['hemi'] = null;
  const head = tokens[i];
  if (head?.kind === 'hemi') {
    hemi = head.hemi ?? null;
    i++;
  }

  const degTok = tokens[i];
  if (degTok?.kind !== 'num') return null;
  i++;
  if (tokens[i]?.kind === 'deg') i++;

  let minutes: Token | undefined;
  let seconds: Token | undefined;
  if (tokens[i]?.kind === 'num') {
    minutes = tokens[i];
    i++;
    if (tokens[i]?.kind === 'min') i++;
    if (tokens[i]?.kind === 'num') {
      seconds = tokens[i];
      i++;
      if (tokens[i]?.kind === 'sec') i++;
    }
  }

  const tail = tokens[i];
  if (tail?.kind === 'hemi') {
    if (hemi !== null) return null; // hemisphere on both ends
    hemi = tail.hemi ?? null;
    i++;
  }
  if (i !== tokens.length) return null; // trailing junk

  // Only the degrees may carry a sign, and never alongside a hemisphere letter.
  if (minutes?.negative || seconds?.negative) return null;
  if (degTok.negative && hemi !== null) return null;
  if (minutes !== undefined) {
    if (!Number.isInteger(degTok.value)) return null; // "46.5° 30'" is nonsense
    if (minutes.value >= 60) return null;
  }
  if (seconds !== undefined) {
    if (!Number.isInteger(minutes?.value ?? 0)) return null;
    if (seconds.value >= 60) return null;
  }

  const magnitude = degTok.value + (minutes?.value ?? 0) / 60 + (seconds?.value ?? 0) / 3600;
  const sign = hemi === 'S' || hemi === 'W' ? -1 : degTok.negative ? -1 : 1;
  return { degrees: sign * magnitude, hemi };
}

const isLatHemi = (h: Component['hemi']): boolean => h === 'N' || h === 'S';

/**
 * Parse a pasted/typed coordinate pair. Returns `null` — never a guess — for
 * anything it cannot read with certainty.
 */
export function parseLatLng(input: string): LatLng | null {
  if (typeof input !== 'string' || input.trim() === '') return null;
  const tokens = tokenize(normalize(input));
  if (tokens === null || tokens.length === 0) return null;
  const halves = splitPair(tokens);
  if (halves === null) return null;

  const a = parseComponent(halves[0]);
  const b = parseComponent(halves[1]);
  if (a === null || b === null) return null;

  let latitude: number;
  let longitude: number;
  if (a.hemi === null && b.hemi === null) {
    // No letters: the universal "lat, lon" reading.
    latitude = a.degrees;
    longitude = b.degrees;
  } else if (a.hemi !== null && b.hemi !== null) {
    // Letters decide which is which — so "W71.2 N46.8" is read correctly.
    if (isLatHemi(a.hemi) === isLatHemi(b.hemi)) return null; // NN / EW-less pairs
    latitude = isLatHemi(a.hemi) ? a.degrees : b.degrees;
    longitude = isLatHemi(a.hemi) ? b.degrees : a.degrees;
  } else {
    return null; // half-labelled pair — ambiguous, so refused
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}
