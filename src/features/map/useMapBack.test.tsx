import { act, render } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { usePhotoCard } from '@features/photos/PhotoBottomCard';
import { useTeamSheet } from '@features/team/map/teamMode';

import { topOpenLayer, useMapBack, useStoreBackLayers, type BackLayer } from './useMapBack';
import { useWaypointClusterSheet } from './waypoints/waypointTap';

jest.mock('@features/photos/PhotoBottomCard', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePhotoCard: create((set: (p: object) => void) => ({
      target: null,
      close: () => set({ target: null }),
    })),
  };
});

jest.mock('@features/team/map/TeamMapOverlay', () => {
  const { create } = jest.requireActual('zustand');
  return {
    useTeamMapSelection: create((set: (p: object) => void) => ({
      hit: null,
      select: (hit: unknown) => set({ hit }),
    })),
  };
});
jest.mock('@features/team/map/teamMode', () => {
  const { create } = jest.requireActual('zustand');
  return {
    useTeamSheet: create((set: (p: object) => void) => ({
      sheet: null,
      close: () => set({ sheet: null }),
    })),
  };
});

/** Android's dispatch: the latest listener first, until one returns true. */
const listeners: (() => boolean | null | undefined)[] = [];
beforeEach(() => {
  listeners.length = 0;
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, fn) => {
    listeners.push(fn);
    return {
      remove: () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
  });
});
afterEach(() => jest.restoreAllMocks());

/** Returns true when the app handled Back (false: Android leaves the app). */
const pressBack = (): boolean => {
  for (const fn of [...listeners].reverse()) if (fn() === true) return true;
  return false;
};

function Probe({ active, layers }: { active: boolean; layers: BackLayer[] }) {
  useMapBack(active, layers);
  return null;
}

describe('useMapBack (QA 2.6.0: Back over the point popup left the app)', () => {
  it('closes the topmost open layer, one per Back, then lets Back leave', async () => {
    const closed: string[] = [];
    const state = { popup: true, card: true };
    const layers = (): BackLayer[] => [
      { open: state.card, close: () => ((state.card = false), closed.push('card')) },
      { open: state.popup, close: () => ((state.popup = false), closed.push('popup')) },
    ];
    const { rerender } = await render(<Probe active layers={layers()} />);
    expect(pressBack()).toBe(true);
    await rerender(<Probe active layers={layers()} />);
    expect(pressBack()).toBe(true);
    await rerender(<Probe active layers={layers()} />);
    expect(closed).toEqual(['card', 'popup']);
    // Nothing open: no listener, Back is the system's.
    expect(listeners).toHaveLength(0);
    expect(pressBack()).toBe(false);
  });

  it('never listens on an unfocused tab', async () => {
    await render(<Probe active={false} layers={[{ open: true, close: jest.fn() }]} />);
    expect(listeners).toHaveLength(0);
  });

  it('registers once, not per render', async () => {
    const close = jest.fn();
    const { rerender } = await render(<Probe active layers={[{ open: true, close }]} />);
    for (let i = 0; i < 5; i++) await rerender(<Probe active layers={[{ open: true, close }]} />);
    expect(BackHandler.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('topOpenLayer: the first open one', () => {
    const a = { open: false, close: jest.fn() };
    const b = { open: true, close: jest.fn() };
    expect(topOpenLayer([a, b])).toBe(b);
    expect(topOpenLayer([a])).toBeNull();
  });
});

describe('useStoreBackLayers: the cards the stores hold', () => {
  function StoreProbe() {
    useMapBack(true, useStoreBackLayers());
    return null;
  }

  it('Back closes the team menu, a photo card and a cluster list', async () => {
    await render(<StoreProbe />);
    await act(async () => {
      useTeamSheet.setState({ sheet: { kind: 'menu' } as never });
      usePhotoCard.setState({ target: {} as never });
      useWaypointClusterSheet.getState().open(['a', 'b']);
    });
    await act(async () => void pressBack());
    expect(useTeamSheet.getState().sheet).toBeNull();
    await act(async () => void pressBack());
    expect(usePhotoCard.getState().target).toBeNull();
    await act(async () => void pressBack());
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
    expect(pressBack()).toBe(false);
  });
});

describe('MapScreen wires every popup and card into Back (source guard: too heavy to mount)', () => {
  const src = jest
    .requireActual<typeof import('node:fs')>('node:fs')
    .readFileSync(`${__dirname}/MapScreen.tsx`, 'utf8');
  const call = src.slice(src.indexOf('useMapBack(isFocused, ['));
  const block = call.slice(0, call.indexOf(']);'));

  it.each([
    'pointAt !== null',
    'viewWp !== null',
    'extensionHit !== null',
    'forecastAt !== null',
    'heatSelection !== null',
    'railMenuOpen',
    '...storeBackLayers',
  ])('%s', (marker) => {
    expect(block).toContain(marker);
  });
});
