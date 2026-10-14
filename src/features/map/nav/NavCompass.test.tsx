/**
 * The linear navigation compass (#672/#678): the heading tape, the flag and
 * its edge arrow, the turn hint with its on-course hysteresis, the trail bar
 * and status while following, the no-magnetometer fallback, both themes, and
 * — measured — that heading frames move the scale every frame while
 * rendering the tape only, and rarely.
 */
import { darkTheme, lightTheme } from '@ui/theme';
import { darkScheme, lightScheme } from '@ui/tokens';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Profiler, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { NavCompass, type NavCompassProps } from './NavCompass';

type Frame = {
  headingDeg: number;
  continuousDeg: number;
  accuracy: number | null;
  moving: boolean;
};
type Listener = (f: Frame) => void;
const mockListeners = new Set<Listener>();
jest.mock('../headingMotion', () => ({
  subscribeHeadingMotion: (l: Listener) => {
    mockListeners.add(l);
    return () => mockListeners.delete(l);
  },
}));

/** One display frame of the heading; a resting one unless `moving`. */
async function heading(deg: number, moving = false) {
  await act(async () => {
    for (const l of mockListeners) {
      l({ headingDeg: ((deg % 360) + 360) % 360, continuousDeg: deg, accuracy: 3, moving });
    }
  });
}

// The no-magnetometer refresh is a timer: fake timers for the whole file
// (toggling them per test breaks the next test's render).
jest.useFakeTimers();

const QC = { latitude: 46.8139, longitude: -71.2082 };
const POINT: NavCompassProps = {
  location: QC,
  targetBearingDeg: 42,
  distance: '1.23 km',
  detail: '042° NE',
};

async function mount(props: Partial<NavCompassProps> = {}, dark = false) {
  const view = await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <NavCompass {...POINT} {...props} />
    </PaperProvider>,
  );
  const slab = screen.queryByTestId('nav-compass');
  if (slab) {
    await fireEvent(slab, 'layout', { nativeEvent: { layout: { width: 358, height: 44 } } });
  }
  return view;
}

/** Re-measure after the tape appears (it hides until a heading exists). */
async function layout() {
  await fireEvent(screen.getByTestId('nav-compass'), 'layout', {
    nativeEvent: { layout: { width: 358, height: 44 } },
  });
}

beforeEach(() => {
  mockListeners.clear();
});

describe('NavCompass', () => {
  it('hides until there is a heading, rather than show a frozen scale', async () => {
    await mount({ location: null });
    expect(screen.queryByTestId('nav-compass')).toBeNull();
  });

  it('pins a destination beyond ±60° to the edge and says which way (mockup: 340° → 042°)', async () => {
    await mount();
    await heading(340);
    await layout();
    expect(screen.getByTestId('nav-compass-edge-right')).toBeTruthy();
    expect(screen.queryByTestId('nav-compass-flag')).toBeNull();
    expect(screen.getByText('Right 62°')).toBeTruthy();
    expect(screen.getByText('1.23 km')).toBeTruthy();
    expect(screen.getByText('042° NE')).toBeTruthy();
    expect(screen.getByLabelText('Navigation compass. 1.23 km, 042° NE. Right 62°')).toBeTruthy();
  });

  it('turns On course within 10°, and only leaves it past 15°', async () => {
    await mount();
    await heading(20); // 22° off
    await layout();
    expect(screen.getByText('Right 22°')).toBeTruthy();
    await heading(33); // 9°
    expect(screen.getByText('On course')).toBeTruthy();
    expect(screen.getByTestId('nav-compass-flag')).toBeTruthy();
    await heading(28); // 14°: still on course (hysteresis)
    expect(screen.getByText('On course')).toBeTruthy();
    await heading(26); // 16°: out
    expect(screen.getByText('Right 16°')).toBeTruthy();
    await heading(31); // 11°: not back in until 10°
    expect(screen.getByText('Right 11°')).toBeTruthy();
  });

  it('outlines the slab in sage on course', async () => {
    await mount();
    await heading(40);
    await layout();
    const style = StyleSheet.flatten(screen.getByTestId('nav-compass').props.style);
    expect(style.borderColor).toBe('#B6C98A');
    expect(style.borderWidth).toBe(2.5);
  });

  it('while following: the trail bar, the target, and the trail status instead of a turn hint', async () => {
    await mount({
      targetBearingDeg: 22,
      trailBearingDeg: 4,
      distance: '1.40 km',
      detail: '› Camp lac',
      status: { text: 'On trail', warn: false },
    });
    await heading(8);
    await layout();
    expect(screen.getByTestId('nav-compass-trail-bar')).toBeTruthy();
    expect(screen.getByTestId('nav-compass-flag')).toBeTruthy();
    expect(screen.getByText('On trail')).toBeTruthy();
    expect(screen.getByText('› Camp lac')).toBeTruthy();
    // Not "On course" even though the flag is near the index.
    expect(screen.queryByText('On course')).toBeNull();
  });

  it('off the trail the status is amber', async () => {
    await mount({ trailBearingDeg: 252, status: { text: 'Off trail 62 m', warn: true } });
    await heading(300);
    await layout();
    const text = screen.getByText('Off trail 62 m');
    expect(StyleSheet.flatten(text.props.style).color).toBe(lightScheme.map.gnssWarn);
    // 252° is 48° left of 300°: on the tape.
    expect(screen.getByTestId('nav-compass-trail-bar')).toBeTruthy();
  });

  it('shrinks the status to fit instead of cutting the number off', async () => {
    await mount({ trailBearingDeg: 252, status: { text: 'Off 1.25 km', warn: true } });
    await heading(300);
    await layout();
    const status = screen.getByTestId('nav-compass-status');
    expect(status.props.adjustsFontSizeToFit).toBe(true);
    expect(status.props.numberOfLines).toBe(1);
  });

  it('leaves out a tick label the edge arrow would cover', async () => {
    await mount(); // target 042°
    await heading(340);
    await layout();
    expect(screen.getByTestId('nav-compass-edge-right')).toBeTruthy();
    // "30" sits at the right edge, under the arrow; "N" is clear.
    expect(screen.queryByTestId('nav-compass-label-30')).toBeNull();
    expect(screen.getByTestId('nav-compass-label-0')).toBeTruthy();
  });

  it('leaves out a tick label under the flag and the trail bar', async () => {
    await mount({
      targetBearingDeg: 60,
      trailBearingDeg: 60,
      status: { text: 'On trail', warn: false },
    });
    await heading(30);
    await layout();
    expect(screen.getByTestId('nav-compass-flag')).toBeTruthy();
    expect(screen.queryByTestId('nav-compass-label-60')).toBeNull();
    expect(screen.getByTestId('nav-compass-label-30')).toBeTruthy();
  });

  it('hides the trail bar outside the window', async () => {
    await mount({ trailBearingDeg: 180, status: { text: 'On trail', warn: false } });
    await heading(0);
    await layout();
    expect(screen.queryByTestId('nav-compass-trail-bar')).toBeNull();
  });

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ])('wears the %s scheme map chrome', async (_name, dark, scheme) => {
    await mount({}, dark);
    await heading(340);
    await layout();
    const style = StyleSheet.flatten(screen.getByTestId('nav-compass').props.style);
    expect(style.backgroundColor).toBe(scheme.map.chrome);
    const hint = screen.getByText('Right 62°');
    expect(StyleSheet.flatten(hint.props.style).color).toBe(scheme.map.chromeInk);
  });
});

describe('NavCompass without a magnetometer', () => {
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const north = (m: number) => ({ latitude: QC.latitude + m / 111_195, longitude: QC.longitude });

  it('drives the tape by course over ground above 0.5 m/s, labelled COG, and hides when you stop', async () => {
    const view = await mount({ location: north(0) });
    expect(screen.queryByTestId('nav-compass')).toBeNull();
    // Walk north at ~1.3 m/s.
    for (let s = 1; s <= 4; s++) {
      now += 1000;
      await view.rerender(
        <PaperProvider theme={lightTheme}>
          <NavCompass {...POINT} location={north(s * 1.3)} />
        </PaperProvider>,
      );
    }
    await layout();
    expect(screen.getByTestId('nav-compass-cog')).toBeTruthy();
    // Heading 0 (north), target 042°: right 42°.
    expect(screen.getByText('Right 42°')).toBeTruthy();
    // Stop: the same fix, re-read on the refresh timer, decays the speed.
    await act(async () => {
      now += 6000;
      jest.advanceTimersByTime(6000);
    });
    expect(screen.queryByTestId('nav-compass')).toBeNull();
  });

  it('prefers the compass the moment it reports', async () => {
    await mount();
    await heading(340);
    await layout();
    expect(screen.queryByTestId('nav-compass-cog')).toBeNull();
  });
});

describe('NavCompass render cost (measured)', () => {
  function Parent({ onCommit }: { onCommit: () => void }) {
    const [props] = useState(POINT);
    return (
      <Profiler id="tape" onRender={onCommit}>
        <NavCompass {...props} />
      </Profiler>
    );
  }

  it('re-renders only itself, and not at all for sub-degree steps', async () => {
    let parentRenders = 0;
    let tapeCommits = 0;
    function Counted() {
      parentRenders++;
      return <Parent onCommit={() => tapeCommits++} />;
    }
    await render(
      <PaperProvider theme={lightTheme}>
        <Counted />
      </PaperProvider>,
    );
    await heading(100);
    await layout();
    const parentBefore = parentRenders;
    const commitsBefore = tapeCommits;
    // Ten frames of 0.09°: below the 1° step, no render at all.
    for (let i = 1; i <= 10; i++) await heading(100 + i * 0.09, true);
    expect(tapeCommits).toBe(commitsBefore);
    // Ten resting 2° steps: ten tape commits, zero parent renders.
    for (let i = 1; i <= 10; i++) await heading(100 + i * 2);
    expect(tapeCommits - commitsBefore).toBe(10);
    expect(parentRenders).toBe(parentBefore);
  });

  it('scrolls the scale every frame of a turn, but renders the text at most every 100 ms', async () => {
    let tapeCommits = 0;
    await render(
      <PaperProvider theme={lightTheme}>
        <Parent onCommit={() => tapeCommits++} />
      </PaperProvider>,
    );
    await heading(100);
    await layout();
    // The strip's offset is a native animated value: watch what is written to it.
    const offsets: number[] = [];
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue').mockImplementation(function (
      this: Animated.Value,
      v: number,
    ) {
      offsets.push(v);
    });
    const commitsBefore = tapeCommits;
    // A brisk 90°/s turn for 1 s at 60 Hz: 1.5° a frame.
    for (let i = 1; i <= 60; i++) {
      await act(async () => {
        jest.advanceTimersByTime(1000 / 60);
      });
      await heading(100 + i * 1.5, true);
    }
    setValue.mockRestore();
    expect(offsets).toHaveLength(60);
    // Every frame moved the strip, by the same amount (1.5° in px), to the left.
    const steps = offsets.slice(1).map((x, i) => x - (offsets[i] ?? NaN));
    const pxPerDeg = (358 - 92 - 96) / 2 / 60;
    for (const step of steps) expect(step).toBeCloseTo(-1.5 * pxPerDeg, 6);
    // …while the readable parts rendered ≤ 10 times in that second (plus one).
    const commits = tapeCommits - commitsBefore;
    expect(commits).toBeGreaterThanOrEqual(9);
    expect(commits).toBeLessThanOrEqual(11);
    // The resting frame always renders the final heading.
    await heading(190.2);
    expect(screen.getByText('Left 148°')).toBeTruthy();
  });
});
