import { DUST_GRANITE, DUST_PAPER } from '@core/anim/inukshukTimeline';
import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { PaperProvider } from 'react-native-paper';
import { cancelAnimation, useReducedMotion } from 'react-native-reanimated';
import { InukshukLoader } from './InukshukLoader';
import { nightTone, STONES } from './inukshukStones';

// Reanimated and Worklets are mocked globally in jest.setup.ts.
const reducedMotion = jest.mocked(useReducedMotion);

interface Node {
  type: string;
  props: Record<string, unknown>;
  children: (Node | string)[] | null;
}

/** Every host node in the rendered tree, depth first. */
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

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

const DUST = new Set([DUST_GRANITE, DUST_PAPER]);
const dustSpecks = () =>
  nodes(screen.toJSON()).filter((n) =>
    DUST.has(flatStyle(n.props.style).backgroundColor as string),
  );
const clipPaths = () => nodes(screen.toJSON()).filter((n) => n.type === 'RNSVGClipPath');

async function renderLoader(ui: ReactElement) {
  await render(<PaperProvider>{ui}</PaperProvider>);
}

beforeEach(() => {
  reducedMotion.mockReturnValue(false);
});

describe('InukshukLoader', () => {
  it('renders the five stones and their dust, announced as a progress bar', async () => {
    await renderLoader(<InukshukLoader testID="loader" />);
    const loader = screen.getByTestId('loader');
    expect(loader).toBeOnTheScreen();
    expect(screen.getByRole('progressbar')).toBe(loader);
    expect(screen.getByLabelText('Loading')).toBe(loader);
    expect(clipPaths()).toHaveLength(STONES.length);
    expect(dustSpecks()).toHaveLength(STONES.length * 5);
  });

  it('lays out at the requested figure height, ~0.9x as wide', async () => {
    await renderLoader(<InukshukLoader testID="loader" size={120} />);
    const style = flatStyle(screen.getByTestId('loader').props.style);
    expect(style.height).toBe(120);
    expect(style.width).toBeCloseTo((120 * 784) / 870);
  });

  it('takes a custom accessibility label', async () => {
    await renderLoader(<InukshukLoader accessibilityLabel="Loading the map catalog" />);
    expect(screen.getByLabelText('Loading the map catalog')).toBeOnTheScreen();
  });

  it('drops the dust at small sizes', async () => {
    await renderLoader(<InukshukLoader size={48} />);
    expect(clipPaths()).toHaveLength(STONES.length);
    expect(dustSpecks()).toHaveLength(0);
  });

  it('under Reduce Motion shows the finished figure still, with no dust', async () => {
    reducedMotion.mockReturnValue(true);
    await renderLoader(<InukshukLoader testID="loader" />);
    expect(screen.getByRole('progressbar')).toBeOnTheScreen();
    expect(clipPaths()).toHaveLength(STONES.length);
    expect(dustSpecks()).toHaveLength(0);
    // Every stone sits at rest, fully opaque (the pulse is on the container).
    const stones = nodes(screen.toJSON()).filter(
      (n) => flatStyle(n.props.style).transformOrigin === '50% 100%',
    );
    expect(stones).toHaveLength(STONES.length);
    for (const s of stones) {
      const st = flatStyle(s.props.style);
      expect(st.opacity).toBe(1);
      expect(st.transform).toEqual([
        { translateX: 0 },
        { translateY: 0 },
        { rotate: '0deg' },
        { scaleX: 1 },
        { scaleY: 1 },
      ]);
    }
  });

  it('cancels its animations when unmounted', async () => {
    await render(
      <PaperProvider>
        <InukshukLoader />
      </PaperProvider>,
    );
    jest.mocked(cancelAnimation).mockClear();
    await screen.unmount();
    // Both the clock and the Reduce Motion pulse.
    expect(cancelAnimation).toHaveBeenCalledTimes(2);
  });
});

describe('nightTone', () => {
  it('lifts the base granite so it reads on dark surfaces', () => {
    expect(nightTone('#273037')).toBe('#656e76');
    expect(nightTone('#ffffff')).toBe('#ffffff');
  });
});
