import { useLibraryStore } from '@state/libraryStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { buildDrawnTrack } from './saveDrawn';
import { SaveRouteSheet } from './SaveRouteSheet';

jest.mock('@data/storage', () => {
  let n = 0;
  return {
    ...jest
      .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
      .documentPathMocks(),
    newId: () => `id_${++n}`,
    ensureStorage: jest.fn(),
    writeIndex: jest.fn(),
    writeJson: jest.fn(),
  };
});
jest.mock('@data/trackGeometry', () => ({ primeTrackGeometry: jest.fn() }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const onSave = jest.fn();
const onCancel = jest.fn();

async function mount(initialCategory: string | null = null) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider>
        <SaveRouteSheet
          initialName="Route 1"
          initialCategory={initialCategory}
          summary="6.9 km · ↑ 610 m"
          estimateFor={(id) => `est ${id}`}
          saving={false}
          editing={initialCategory !== null}
          onSave={onSave}
          onCancel={onCancel}
        />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

const press = async (label: string) => {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
};

const summary = () => screen.getByTestId('save-route-summary');

beforeEach(() => {
  onSave.mockReset();
  onCancel.mockReset();
  useLibraryStore.setState({
    customCategories: [{ id: 'c1', name: 'Packrafting', color: '#C74FA0', createdAt: 1 }],
  });
});

describe('SaveRouteSheet activity chips (#736)', () => {
  it('shows Navigation trail first, selected, then the common activities and "+"', async () => {
    await mount();
    const chips = screen
      .getAllByLabelText(/^Activity |^More activities$/)
      .map((n) => n.props.accessibilityLabel as string);
    expect(chips).toEqual([
      'Activity Navigation trail, selected',
      'Activity Hike',
      'Activity Trail Run',
      'Activity Bike',
      'Activity Ski',
      'More activities',
    ]);
    expect(summary()).toHaveTextContent('6.9 km · ↑ 610 m · est navigation');
    await press('Save route to Library');
    expect(onSave).toHaveBeenCalledWith('Route 1', 'navigation');
  });

  it('toggles a chip on, updates the estimate, and back to Navigation trail', async () => {
    await mount();
    await press('Activity Bike');
    expect(screen.getByLabelText('Activity Bike, selected')).toBeOnTheScreen();
    expect(screen.getByLabelText('Activity Navigation trail')).toBeOnTheScreen();
    expect(summary()).toHaveTextContent(/est bike$/);
    await press('Activity Bike, selected');
    expect(screen.getByLabelText('Activity Navigation trail, selected')).toBeOnTheScreen();
    expect(summary()).toHaveTextContent(/est navigation$/);
  });

  it('"+" lists every built-in, then custom activities, then New activity…', async () => {
    await mount();
    expect(screen.queryByLabelText('New activity')).toBeNull();
    await press('More activities');
    const rows = screen.getAllByRole('menuitem').map((n) => n.props.accessibilityLabel as string);
    expect(rows).toEqual([
      'Hike',
      'Run',
      'Trail Run',
      'Bike',
      'Ski',
      'Snowshoe',
      'Walk',
      'Navigation trail, selected',
      'Other',
      'Packrafting',
      'New activity',
    ]);
  });

  it('choosing from "+" selects it and shows it as a chip before "+"', async () => {
    await mount();
    await press('More activities');
    await press('Snowshoe');
    expect(screen.queryByRole('menuitem')).toBeNull();
    const chips = screen
      .getAllByLabelText(/^Activity |^More activities$/)
      .map((n) => n.props.accessibilityLabel as string);
    expect(chips.slice(-2)).toEqual(['Activity Snowshoe, selected', 'More activities']);
    expect(summary()).toHaveTextContent(/est snowshoe$/);
    // A common one picked from the list adds no chip.
    await press('More activities');
    await press('Hike');
    expect(screen.getByLabelText('Activity Hike, selected')).toBeOnTheScreen();
    expect(screen.getByLabelText('Activity Snowshoe')).toBeOnTheScreen();
    await press('Save route to Library');
    expect(onSave).toHaveBeenCalledWith('Route 1', 'hike');
  });

  it('New activity… creates a custom activity and selects it', async () => {
    await mount();
    await press('More activities');
    await press('New activity');
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Activity name'), 'Canicross');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Add'));
    });
    const created = useLibraryStore.getState().customCategories.find((c) => c.name === 'Canicross');
    expect(created).toBeDefined();
    expect(screen.getByLabelText('Activity Canicross, selected')).toBeOnTheScreen();
    await press('Save route to Library');
    expect(onSave).toHaveBeenCalledWith('Route 1', created?.id);
  });

  it('editing preselects the route activity, even one without a common chip', async () => {
    await mount('c1');
    expect(screen.getByLabelText('Activity Packrafting, selected')).toBeOnTheScreen();
    expect(screen.getByLabelText('Activity Navigation trail')).toBeOnTheScreen();
    await press('Save route to Library');
    expect(onSave).toHaveBeenCalledWith('Route 1', 'c1');
  });

  it.each(['navigation', 'gone'])('editing a %s route preselects Navigation trail', async (id) => {
    await mount(id);
    expect(screen.getByLabelText('Activity Navigation trail, selected')).toBeOnTheScreen();
  });

  it('Back folds the "+" list before it cancels the sheet', async () => {
    const handlers: (() => boolean)[] = [];
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_, h) => {
      handlers.push(h as () => boolean);
      return { remove: jest.fn() };
    });
    await mount();
    await press('More activities');
    await act(async () => {
      handlers.forEach((h) => h());
    });
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => {
      handlers.forEach((h) => h());
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('Navigation trail compatibility', () => {
  it('saving Navigation trail files the route exactly as "none" did', () => {
    const base = {
      vertices: [
        [-71.215, 46.81],
        [-71.21, 46.812],
      ] as [number, number][],
      name: 'Route 1',
      elevation: null,
    };
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const asNone = buildDrawnTrack('t', { ...base, category: null });
    const asNavigation = buildDrawnTrack('t', { ...base, category: 'navigation' });
    now.mockRestore();
    expect(asNavigation).toEqual(asNone);
    expect(asNavigation.category).toBe('navigation');
  });
});
