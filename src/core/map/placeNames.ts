/**
 * Which name a country or province label shows, in the label language the
 * stone style is built for — as plain TypeScript (for tests and the
 * dataset build) and as the MapLibre expression the style draws with. The
 * two are kept in step by `placeNames.test.ts`, which evaluates the
 * expression against the same cases.
 *
 * OpenStreetMap's `name` is the name on the ground, and where a country or
 * province has several official languages it carries all of them:
 * "Schweiz/Suisse/Svizzera/Svizra", "België / Belgique / Belgien",
 * "New Brunswick;Nouveau-Brunswick". Drawn as-is that is a sentence, not a
 * label. So:
 *
 * - `fr` / `en`: the `name:fr` / `name:en` translation when tagged — the
 *   right answer for every multi-lingual country ("Suisse", "Switzerland");
 * - otherwise (and always for `local`): the FIRST of the listed names, which
 *   by OSM convention is the majority language's ("Schweiz", "België").
 *
 * PURE: no platform imports.
 */
import type { LineLayerSpecification } from '@maplibre/maplibre-react-native';
import type { StoneLabelLanguage } from './stoneStyle';

type ExpressionSpecification = Extract<
  NonNullable<NonNullable<LineLayerSpecification['paint']>['line-width']>,
  unknown[]
>;

/**
 * The separators a multi-valued name is cut at, in order. The spaced form of
 * each comes first, so "België / Belgique" loses its trailing space too
 * (MapLibre has no trim); ';' is OSM's own multi-value separator.
 */
export const NAME_SEPARATORS: readonly string[] = [' ;', ';', ' /', '/'];

/** The first of the names in a multi-valued `name` ("Schweiz/Suisse" → "Schweiz"). */
export function firstNameSegment(name: string): string {
  let out = name;
  for (const sep of NAME_SEPARATORS) {
    const at = out.indexOf(sep);
    // A name that STARTS with a separator is not multi-valued; keep it whole.
    if (at > 0) out = out.slice(0, at);
  }
  return out;
}

/** The properties a place label reads (OSM / Protomaps keys). */
export type PlaceNameProps = Readonly<Record<string, unknown>>;

/** The label text for a place in `language`; '' when it has no name at all. */
export function pickPlaceName(props: PlaceNameProps, language: StoneLabelLanguage): string {
  if (language !== 'local') {
    const translated = props[`name:${language}`];
    if (typeof translated === 'string' && translated !== '') return translated;
  }
  const name = props.name;
  return typeof name === 'string' ? firstNameSegment(name) : '';
}

/** {@link firstNameSegment} as an expression over `input`. */
function firstSegmentExpression(input: ExpressionSpecification): ExpressionSpecification {
  // One `let` per separator, so `input` is read once rather than 3^n times.
  let body: ExpressionSpecification = ['var', `n${NAME_SEPARATORS.length}`];
  for (let i = NAME_SEPARATORS.length - 1; i >= 0; i--) {
    const sep = NAME_SEPARATORS[i] ?? '';
    const from: ExpressionSpecification = ['var', `n${i}`];
    const at: ExpressionSpecification = ['index-of', sep, from];
    body = [
      'let',
      `n${i + 1}`,
      ['case', ['>', at, 0], ['slice', from, 0, at], from],
      body,
    ] as ExpressionSpecification;
  }
  return ['let', 'n0', input, body] as ExpressionSpecification;
}

/**
 * {@link pickPlaceName} as a MapLibre expression: the translation when
 * tagged (fr/en), else the first segment of `name`, else ''.
 */
export function placeNameExpression(language: StoneLabelLanguage): ExpressionSpecification {
  const local = firstSegmentExpression(['to-string', ['coalesce', ['get', 'name'], '']]);
  if (language === 'local') return local;
  const key = `name:${language}`;
  return [
    'case',
    ['all', ['has', key], ['!=', ['to-string', ['get', key]], '']],
    ['to-string', ['get', key]],
    local,
  ];
}
