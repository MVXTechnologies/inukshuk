/**
 * The public support pages (docs/support, docs/fr/support; #476). They are
 * static HTML with an inline script, so they are pinned at the source level:
 * percentages only (owner rule — no budget, no dollar amounts), the two goals
 * in both languages, and a script that reads `goals` rather than amounts.
 * The rendering itself is checked in headless Chrome (see the PR).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const page = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe.each([
  ['EN', 'docs/support/index.html', ['Keep the app up', 'Implement new features']],
  [
    'FR',
    'docs/fr/support/index.html',
    ['Garder l’application en ligne', 'Développer de nouvelles fonctionnalités'],
  ],
])('%s support page', (_lang, path, labels) => {
  const html = page(path);

  it('shows no amount of money anywhere', () => {
    expect(html).not.toMatch(/\$\s?\d|\d\s?\$|€|\bUSD\b|\bCAD\b/);
    expect(html).not.toMatch(/data-(raised|goal|costs|ledger|total)(?![-\w])/);
  });

  it('names both goals', () => {
    for (const label of labels) expect(html).toContain(label);
  });

  it('renders goals from costs.json, as percentages', () => {
    expect(html).toContain('doc.goals');
    expect(html).toMatch(/percent/);
    expect(html).not.toMatch(/doc\.(raised|goal|costs|ledger)\b/);
  });

  it('keeps the donors list, how to give, the tax note and the t-shirt placeholder', () => {
    expect(html).toContain('id="donors"');
    expect(html).toContain('id="give"');
    expect(html).toMatch(/tax-deductible|déductibles d’impôt/);
    expect(html).toMatch(/MERCH PLACEHOLDER|ESPACE RÉSERVÉ À LA BOUTIQUE/);
  });
});
