import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { MD3DarkTheme, PaperProvider } from 'react-native-paper';
import { DisplayConditionContext } from '../displayCondition';
import { InukshukGlyph, stoneInset } from './InukshukGlyph';
import { FIGURE_H, FIGURE_W, nightTone, STONES } from './inukshukStones';

interface Node {
  type: string;
  props: Record<string, unknown>;
  children: (Node | string)[] | null;
}

function nodes(tree: unknown): Node[] {
  const out: Node[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as Node;
    out.push(node);
    node.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

const OUTLINES = new Set(STONES.map((s) => s.outline));
/** The visible stone bodies: an outline path given its own fill (not the clip path copy). */
const stoneBodies = () =>
  nodes(screen.toJSON()).filter(
    (n) =>
      n.type === 'RNSVGPath' &&
      OUTLINES.has(n.props.d as string) &&
      ((n.props.propList as string[] | undefined) ?? []).includes('fill'),
  );
const fillOf = (n: Node) => JSON.stringify(n.props.fill);
const facetCount = STONES.reduce((sum, s) => sum + s.facets.length, 0);

async function renderGlyph(ui: ReactElement, dark = false) {
  await render(<PaperProvider theme={dark ? MD3DarkTheme : undefined}>{ui}</PaperProvider>);
}

describe('InukshukGlyph', () => {
  it('draws exactly the five stones of the app icon', async () => {
    await renderGlyph(<InukshukGlyph tone="day" testID="g" />);
    const bodies = stoneBodies();
    expect(bodies).toHaveLength(5);
    expect(new Set(bodies.map((b) => b.props.d))).toEqual(OUTLINES);
    expect(STONES.map((s) => s.id)).toEqual(['leg-left', 'leg-right', 'torso', 'arm', 'head']);
    // Every stone keeps its facet highlights, each clipped to its outline.
    const paths = nodes(screen.toJSON()).filter((n) => n.type === 'RNSVGPath');
    expect(paths).toHaveLength(5 /* clip */ + 5 /* body */ + facetCount);
    expect(nodes(screen.toJSON()).filter((n) => n.type === 'RNSVGClipPath')).toHaveLength(5);
  });

  it('sizes the figure by its height, keeping the icon proportions', async () => {
    await renderGlyph(<InukshukGlyph tone="day" size={87} testID="g" />);
    expect(screen.getByTestId('g', { includeHiddenElements: true })).toHaveStyle({
      height: 87,
      width: (87 * FIGURE_W) / FIGURE_H,
    });
  });

  it('fits the figure inside a square frame like an icon glyph', async () => {
    await renderGlyph(<InukshukGlyph tone="mono" size={24} frame="square" testID="g" />);
    expect(screen.getByTestId('g', { includeHiddenElements: true })).toHaveStyle({
      width: 24,
      height: 24,
    });
  });

  it('mono draws five flat stones in the given colour, no facets', async () => {
    await renderGlyph(<InukshukGlyph tone="mono" color="#ffffff" />);
    const bodies = stoneBodies();
    expect(bodies).toHaveLength(5);
    expect(nodes(screen.toJSON()).filter((n) => n.type === 'RNSVGPath')).toHaveLength(5);
    expect(new Set(bodies.map(fillOf)).size).toBe(1);
    expect(nodes(screen.toJSON()).filter((n) => n.type === 'RNSVGClipPath')).toHaveLength(0);
  });

  it('auto follows the theme: night tone on dark, day granite on light', async () => {
    const fills = async (ui: ReactElement, dark: boolean) => {
      const view = await render(
        <PaperProvider theme={dark ? MD3DarkTheme : undefined}>{ui}</PaperProvider>,
      );
      const out = new Set(
        nodes(view.toJSON())
          .filter((n) => n.type === 'RNSVGPath')
          .map(fillOf),
      );
      await view.unmount();
      return out;
    };
    const autoDark = await fills(<InukshukGlyph />, true);
    expect(autoDark).toEqual(await fills(<InukshukGlyph tone="night" />, false));
    const autoLight = await fills(<InukshukGlyph />, false);
    expect(autoLight).toEqual(await fills(<InukshukGlyph tone="day" />, true));
    expect(autoLight).not.toEqual(autoDark);
    // The night tone is the splash-dark transform of the day granite.
    expect(nightTone('#273037')).toBe('#656e76');
  });

  it('goes mono in the high-contrast display modes', async () => {
    await render(
      <PaperProvider>
        <DisplayConditionContext.Provider value="night">
          <InukshukGlyph />
        </DisplayConditionContext.Provider>
      </PaperProvider>,
    );
    expect(stoneBodies()).toHaveLength(5);
    expect(nodes(screen.toJSON()).filter((n) => n.type === 'RNSVGClipPath')).toHaveLength(0);
  });

  it('is decorative unless labelled', async () => {
    await renderGlyph(<InukshukGlyph testID="g" />);
    expect(screen.queryByRole('image')).toBeNull();
    expect(screen.getByTestId('g', { includeHiddenElements: true })).toBeTruthy();
  });

  it('is announced as an image when labelled', async () => {
    await renderGlyph(<InukshukGlyph accessibilityLabel="Inukshuk" />);
    expect(screen.getByRole('image', { name: 'Inukshuk' })).toBeOnTheScreen();
  });

  it('opens a visible joint between stones at every size', () => {
    // Inset per side (figure units) × scale = half the gap in dp.
    for (const h of [17, 24, 64, 140]) {
      const k = h / FIGURE_H;
      expect(2 * stoneInset(h, true) * k).toBeGreaterThanOrEqual(1);
      expect(2 * stoneInset(h, false) * k).toBeCloseTo(h * 0.015);
    }
  });
});
