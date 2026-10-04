import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { firstNameSegment, pickPlaceName, placeNameExpression } from './placeNames';
import type { StoneLabelLanguage } from './stoneStyle';

/** Real multi-valued names from the Protomaps `places` layer (2026-10). */
const SWITZERLAND = {
  name: 'Schweiz/Suisse/Svizzera/Svizra',
  'name:fr': 'Suisse',
  'name:en': 'Switzerland',
};
const BELGIUM = { name: 'België / Belgique / Belgien', 'name:fr': 'Belgique' };
const NEW_BRUNSWICK = { name: 'New Brunswick;Nouveau-Brunswick', 'name:fr': 'Nouveau-Brunswick' };
const FRANCE = { name: 'France', 'name:en': 'France', 'name:fr': 'France' };
const JAPAN = { name: '日本', 'name:en': 'Japan', 'name:fr': 'Japon' };

const CASES: [string, Record<string, unknown>, StoneLabelLanguage, string][] = [
  ['Switzerland, local', SWITZERLAND, 'local', 'Schweiz'],
  ['Switzerland, fr', SWITZERLAND, 'fr', 'Suisse'],
  ['Switzerland, en', SWITZERLAND, 'en', 'Switzerland'],
  // No English tag: the first listed name, without the space before " / ".
  ['Belgium, en (untagged)', BELGIUM, 'en', 'België'],
  ['Belgium, local', BELGIUM, 'local', 'België'],
  ['Belgium, fr', BELGIUM, 'fr', 'Belgique'],
  ['New Brunswick, local', NEW_BRUNSWICK, 'local', 'New Brunswick'],
  ['New Brunswick, en (untagged)', NEW_BRUNSWICK, 'en', 'New Brunswick'],
  ['New Brunswick, fr', NEW_BRUNSWICK, 'fr', 'Nouveau-Brunswick'],
  ['spaced semicolon', { name: 'Alpha ; Beta' }, 'local', 'Alpha'],
  ['plain name', FRANCE, 'local', 'France'],
  ['non-Latin local', JAPAN, 'local', '日本'],
  ['non-Latin, fr', JAPAN, 'fr', 'Japon'],
  ['empty translation falls back', { name: 'Bayern', 'name:fr': '' }, 'fr', 'Bayern'],
  ['leading separator kept whole', { name: '/x' }, 'local', '/x'],
  ['no name at all', {}, 'local', ''],
  ['no name, fr', {}, 'fr', ''],
];

const TEXT_FIELD = {
  type: 'string',
  'property-type': 'data-driven',
  expression: { interpolated: false, parameters: ['zoom', 'feature'] },
} as never;

function evaluate(language: StoneLabelLanguage, properties: Record<string, unknown>): unknown {
  const compiled = createExpression(placeNameExpression(language), TEXT_FIELD);
  if (compiled.result !== 'success') throw new Error(JSON.stringify(compiled.value));
  const value = compiled.value.evaluate({ zoom: 4 }, {
    type: 1,
    properties,
  } as never);
  return typeof value === 'string' ? value : String(value);
}

describe('pickPlaceName', () => {
  it.each(CASES)('%s', (_, props, language, expected) => {
    expect(pickPlaceName(props, language)).toBe(expected);
  });
});

describe('placeNameExpression (the same rules, as MapLibre evaluates them)', () => {
  it.each(CASES)('%s', (_, props, language, expected) => {
    expect(evaluate(language, props)).toBe(expected);
  });

  it.each(['local', 'fr', 'en'] as const)('never reads the zoom (%s)', (language) => {
    expect(JSON.stringify(placeNameExpression(language))).not.toContain('"zoom"');
  });
});

describe('firstNameSegment', () => {
  it('cuts at the first separator of each kind in turn', () => {
    expect(firstNameSegment('A;B/C')).toBe('A');
    expect(firstNameSegment('A/B;C')).toBe('A');
    expect(firstNameSegment('Bruxelles-Capitale')).toBe('Bruxelles-Capitale');
  });
});
