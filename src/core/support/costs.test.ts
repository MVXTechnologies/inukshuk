import { readFileSync } from 'fs';
import { join } from 'path';

import { clampPercent, GOALS, goalsView, hasContent, parseCostsDocument } from './costs';

describe('hasContent', () => {
  it('rejects a document that carries none of the fields', () => {
    const empty = parseCostsDocument({ junk: true }).doc;
    expect(empty !== null && hasContent(empty)).toBe(false);
    const withGoals = parseCostsDocument({ goals: [] }).doc;
    expect(withGoals !== null && hasContent(withGoals)).toBe(true);
    const withSupporters = parseCostsDocument({ supporters: 3 }).doc;
    expect(withSupporters !== null && hasContent(withSupporters)).toBe(true);
  });
});

const valid = {
  year: 2026,
  goals: [
    { id: 'keepUp', percent: 40 },
    { id: 'features', percent: 0 },
  ],
  supporters: 37,
  updated: '2026-09-30',
  donors: [{ name: 'Anne T.', place: 'Rimouski', since: 2026 }],
};

describe('parseCostsDocument', () => {
  it('parses the public shape', () => {
    expect(parseCostsDocument(valid)).toEqual({
      doc: {
        year: 2026,
        goals: [
          { id: 'keepUp', percent: 40 },
          { id: 'features', percent: 0 },
        ],
        supporters: 37,
        updated: '2026-09-30',
        donors: [{ name: 'Anne T.', place: 'Rimouski', since: 2026 }],
      },
      warnings: [],
    });
  });

  it('parses the published docs/support/costs.json, which discloses no amounts', () => {
    const text = readFileSync(join(__dirname, '../../../docs/support/costs.json'), 'utf8');
    const { doc, warnings } = parseCostsDocument(JSON.parse(text) as unknown);
    expect(warnings).toEqual([]);
    expect(doc?.goals).toHaveLength(2);
    // Owner rule: percentages only — no goal amount, raised amount, costs or ledger.
    for (const key of ['goal', 'raised', 'costs', 'ledger', 'currency', 'amount']) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(text).not.toMatch(/\$|USD|CAD/);
  });

  it.each([
    [-5, 0],
    [12.4, 12],
    [99.6, 100],
    [140, 100],
  ])('clamps a goal percent of %p to %p', (input, expected) => {
    const { doc } = parseCostsDocument({ goals: [{ id: 'keepUp', percent: input }] });
    expect(doc?.goals?.[0]?.percent).toBe(expected);
  });

  it('puts goals in funding order, fills in missing ones at 0 % and ignores unknown ones', () => {
    const { doc, warnings } = parseCostsDocument({
      goals: [
        { id: 'features', percent: 10 },
        { id: 'moonshot', percent: 50 },
      ],
    });
    expect(doc?.goals).toEqual([
      { id: 'keepUp', percent: 0 },
      { id: 'features', percent: 10 },
    ]);
    expect(warnings).toEqual([]);
  });

  it('tolerates missing fields, hiding only what they drive', () => {
    expect(parseCostsDocument({})).toEqual({
      doc: { year: null, goals: null, supporters: null, updated: null, donors: [] },
      warnings: [],
    });
  });

  it('flags junk fields and drops bad rows', () => {
    const { doc, warnings } = parseCostsDocument({
      year: 'soon',
      goals: [{ id: 'keepUp', percent: 'lots' }, 'x', { percent: 5 }],
      supporters: -3,
      updated: 'today',
      donors: [{ name: 'Luc' }, { name: '' }, 7],
    });
    expect(doc).toMatchObject({ year: null, supporters: null, updated: null });
    expect(doc?.goals).toEqual([
      { id: 'keepUp', percent: 0 },
      { id: 'features', percent: 0 },
    ]);
    expect(doc?.donors).toEqual([{ name: 'Luc', place: null, since: null }]);
    expect(warnings).toHaveLength(7);
    expect(parseCostsDocument({ goals: 'full' }).warnings).toEqual(['costs: goals is not a list']);
  });

  it('rejects a payload that is not an object', () => {
    expect(parseCostsDocument([]).doc).toBeNull();
    expect(parseCostsDocument(null).doc).toBeNull();
  });
});

describe('goalsView', () => {
  it('shows the first goal while it is under 100 %', () => {
    const view = goalsView([
      { id: 'keepUp', percent: 40 },
      { id: 'features', percent: 0 },
    ]);
    expect(view.funded).toEqual([]);
    expect(view.active).toMatchObject({ id: 'keepUp', label: 'Keep the app up', percent: 40 });
  });

  it('moves on to new features once the app is kept up', () => {
    const view = goalsView([
      { id: 'keepUp', percent: 100 },
      { id: 'features', percent: 15 },
    ]);
    expect(view.funded.map((g) => g.id)).toEqual(['keepUp']);
    expect(view.active).toMatchObject({
      id: 'features',
      label: 'Implement new features',
      percent: 15,
    });
  });

  it('knows when both goals are funded', () => {
    const view = goalsView([
      { id: 'keepUp', percent: 100 },
      { id: 'features', percent: 100 },
    ]);
    expect(view.funded.map((g) => g.id)).toEqual(['keepUp', 'features']);
    expect(view.active).toBeNull();
  });

  it('treats a missing goal as not yet funded', () => {
    expect(goalsView([]).active?.id).toBe('keepUp');
  });
});

describe('goals and what they pay for', () => {
  it('are two, in order, and name no amounts', () => {
    expect(GOALS.map((g) => g.id)).toEqual(['keepUp', 'features']);
    expect(GOALS[0]?.payFor).toEqual([
      'Map servers and data',
      'App store accounts and licences',
      'Test devices and software',
    ]);
    expect(GOALS[1]?.payFor).toEqual(['Developer time']);
    for (const g of GOALS) for (const line of g.payFor) expect(line).not.toMatch(/\d|\$/);
  });

  it('clampPercent refuses non-numbers', () => {
    expect(clampPercent(Number.NaN)).toBeNull();
    expect(clampPercent('12')).toBeNull();
  });
});
