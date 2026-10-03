import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  admin1Point,
  buildAdmin1Labels,
  cleanEnglishName,
  cleanFrenchName,
  dueZoom,
  geometryAreaKm2,
  MAX_RANK,
  MIN_RANK,
  rankOf,
  REGION_UNTIL,
  serializeAdmin1Labels,
} from './admin1Labels.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A lon/lat box as a GeoJSON Polygon. */
function box(w, s, e, n) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

/** A Natural Earth admin-1 feature, with the fields the build reads. */
function ne(props, geometry) {
  const [w, s, e, n] = props.bbox;
  return {
    type: 'Feature',
    geometry: geometry ?? box(w, s, e, n),
    properties: {
      longitude: (w + e) / 2,
      latitude: (s + n) / 2,
      region: null,
      ...props,
    },
  };
}

describe('cleanFrenchName', () => {
  it('drops the generic lower-case prefixes Natural Earth adds', () => {
    assert.equal(cleanFrenchName('canton de Vaud'), 'Vaud');
    assert.equal(cleanFrenchName('canton des Grisons'), 'Grisons');
    assert.equal(cleanFrenchName("canton d'Argovie"), 'Argovie');
    assert.equal(cleanFrenchName('voïvodie de Lublin'), 'Lublin');
    assert.equal(cleanFrenchName("république de l'Altaï"), 'Altaï');
    assert.equal(cleanFrenchName('du Primorié'), 'Primorié');
    assert.equal(cleanFrenchName("d'Omsk"), 'Omsk');
  });

  it('keeps names that are names, capitalised', () => {
    assert.equal(cleanFrenchName('Bavière'), 'Bavière');
    assert.equal(cleanFrenchName('République autonome de Crimée'), 'République autonome de Crimée');
    assert.equal(cleanFrenchName('la Mecque'), 'La Mecque');
    assert.equal(cleanFrenchName(''), null);
    assert.equal(cleanFrenchName(undefined), null);
  });
});

describe('cleanEnglishName', () => {
  it('drops type words that only lengthen a label', () => {
    assert.equal(cleanEnglishName('Kagoshima Prefecture'), 'Kagoshima');
    assert.equal(cleanEnglishName('Lower Austria'), 'Lower Austria');
    assert.equal(cleanEnglishName(null), null);
  });
});

describe('geometryAreaKm2', () => {
  it('measures a 1°×1° box at the equator as ~12 364 km²', () => {
    assert.ok(Math.abs(geometryAreaKm2(box(0, 0, 1, 1)) - 12364) < 50);
  });

  it('subtracts holes and sums multipolygons', () => {
    const outer = box(0, 0, 2, 2).coordinates[0];
    const hole = box(0.5, 0.5, 1.5, 1.5).coordinates[0];
    const withHole = geometryAreaKm2({ type: 'Polygon', coordinates: [outer, hole] });
    const full = geometryAreaKm2(box(0, 0, 2, 2));
    const inner = geometryAreaKm2(box(0.5, 0.5, 1.5, 1.5));
    assert.ok(Math.abs(withHole - (full - inner)) < 1);
    const two = geometryAreaKm2({
      type: 'MultiPolygon',
      coordinates: [box(0, 0, 1, 1).coordinates, box(5, 0, 6, 1).coordinates],
    });
    assert.ok(Math.abs(two - 2 * geometryAreaKm2(box(0, 0, 1, 1))) < 1);
    assert.equal(geometryAreaKm2(null), 0);
  });
});

describe('dueZoom / rankOf', () => {
  it('brings big provinces in early and small ones late', () => {
    // Québec (~1.5 M km²) at z2–3; Bavaria (~70 000 km²) by z5; a French
    // département (~6 000 km²) at z6; Basel-Stadt (37 km²) never by z8.
    assert.equal(rankOf(dueZoom(1_500_000, 52)), MIN_RANK);
    assert.equal(rankOf(dueZoom(70_000, 49)), 4);
    assert.equal(rankOf(dueZoom(6_000, 45)), 6);
    assert.ok(rankOf(dueZoom(37, 47.5)) > MAX_RANK);
  });

  it('draws the same area earlier further north (Mercator)', () => {
    assert.ok(dueZoom(10_000, 65) < dueZoom(10_000, 10));
  });

  it('never ranks an area-less province', () => {
    assert.equal(dueZoom(0, 45), Infinity);
  });
});

describe('admin1Point', () => {
  it('skips unnamed features (Antarctica and friends)', () => {
    assert.equal(admin1Point(ne({ name: null, bbox: [0, 0, 1, 1] })), null);
  });
});

describe('buildAdmin1Labels', () => {
  const swiss = ne({
    name: 'Graubünden',
    name_fr: 'canton des Grisons',
    name_en: 'Grisons',
    iso_a2: 'CH',
    bbox: [8.6, 46.2, 10.5, 47.1],
  });
  const tiny = ne({ name: 'Basel-Stadt', iso_a2: 'CH', bbox: [7.55, 47.52, 7.65, 47.6] });
  const savoie = ne({
    name: 'Savoie',
    name_fr: 'Savoie',
    name_en: 'Savoie',
    iso_a2: 'FR',
    region: 'Auvergne-Rhône-Alpes',
    bbox: [5.6, 45.1, 7.2, 45.9],
  });
  const isere = ne({
    name: 'Isère',
    iso_a2: 'FR',
    region: 'Auvergne-Rhône-Alpes',
    bbox: [4.7, 44.7, 6.4, 45.9],
  });
  const guyane = ne({
    name: 'Guyane française',
    name_fr: 'Guyane',
    iso_a2: 'FR',
    region: 'Guyane française',
    bbox: [-54.6, 2.1, -51.6, 5.8],
  });
  const built = buildAdmin1Labels({
    type: 'FeatureCollection',
    features: [swiss, tiny, savoie, isere, guyane],
  });
  const byName = (n) => built.features.find((f) => f.properties.name === n);

  it('keeps a named province with cleaned translations, only where they differ', () => {
    const g = byName('Graubünden');
    assert.deepEqual(g.properties, {
      name: 'Graubünden',
      'name:fr': 'Grisons',
      'name:en': 'Grisons',
      r: 5,
    });
    const s = byName('Savoie');
    assert.equal(s.properties['name:fr'], undefined);
    assert.equal(s.properties['name:en'], undefined);
  });

  it('drops provinces too small to be due by the last province zoom', () => {
    assert.equal(byName('Basel-Stadt'), undefined);
  });

  it('groups French départements into their région, shown below REGION_UNTIL', () => {
    const region = byName('Auvergne-Rhône-Alpes');
    assert.ok(region);
    assert.equal(region.properties.u, REGION_UNTIL);
    assert.ok(region.properties.r < REGION_UNTIL);
    // At the members' area-weighted centre, between the two.
    const [lon, lat] = region.geometry.coordinates;
    assert.ok(lon > 5.5 && lon < 6.4 && lat > 45.1 && lat < 45.6);
    // …and the members held back until the région hides.
    assert.equal(byName('Savoie').properties.r, REGION_UNTIL);
    assert.equal(byName('Isère').properties.r, REGION_UNTIL);
  });

  it('does not double a one-member region (overseas départements)', () => {
    const named = built.features.filter((f) => f.properties.name === 'Guyane française');
    assert.equal(named.length, 1);
    assert.equal(named[0].properties.u, undefined);
    assert.equal(named[0].properties['name:fr'], 'Guyane');
  });

  it('rounds coordinates and sorts by rank, then name', () => {
    for (const f of built.features) {
      for (const c of f.geometry.coordinates) assert.equal(Math.round(c * 100) / 100, c);
    }
    const ranks = built.features.map((f) => f.properties.r);
    assert.deepEqual(
      ranks,
      [...ranks].sort((a, b) => a - b),
    );
  });

  it('serialises one feature per line, as valid JSON', () => {
    const text = serializeAdmin1Labels(built);
    assert.deepEqual(JSON.parse(text), built);
    assert.equal(text.split('\n').length, built.features.length + 3);
  });
});

describe('the checked-in dataset (docs/data/admin1-labels-v1.json)', () => {
  const data = JSON.parse(
    readFileSync(resolve(repoRoot, 'docs/data/admin1-labels-v1.json'), 'utf8'),
  );
  const names = new Set(data.features.map((f) => f.properties.name));

  it('stays compact', () => {
    assert.ok(data.features.length > 2500 && data.features.length < 5000);
    const bytes = readFileSync(resolve(repoRoot, 'docs/data/admin1-labels-v1.json')).length;
    assert.ok(bytes < 600 * 1024, `${bytes} bytes`);
  });

  it('names the provinces the owner found missing', () => {
    for (const n of [
      'Valais',
      'Graubünden',
      'Bayern',
      'Occitanie',
      'Lombardia',
      'Québec',
      'Ontario',
    ]) {
      assert.ok(names.has(n), n);
    }
  });

  it('gives every point a name and a rank the style can draw', () => {
    for (const f of data.features) {
      assert.equal(typeof f.properties.name, 'string');
      assert.ok(f.properties.name.length > 0);
      assert.ok(f.properties.r >= MIN_RANK && f.properties.r <= MAX_RANK);
      assert.ok(!/[;/]/.test(f.properties.name), f.properties.name);
    }
  });
});
