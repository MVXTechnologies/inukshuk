/** Round 2 of #476: the donors offer, the donor form, the donors list. */
import type { CostsDocument } from '@core/support/costs';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSupportStore } from '@state/supportStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import { useReducedMotion } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DonorFormScreen } from './DonorFormScreen';
import { DonorsList } from './DonorsList';
import { SupportThanksScreen } from './SupportThanksScreen';

const mockPush = jest.fn();
const mockDismissTo = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, dismissTo: mockDismissTo, back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  readJson: jest.fn(async () => null),
}));

let mockCosts: { doc: CostsDocument; fromCache: boolean } | null = null;
jest.mock('@data/supportCosts', () => ({ loadSupportCosts: jest.fn(async () => mockCosts) }));

const mockSubmit = jest.fn();
jest.mock('@data/donorSubmit', () => ({
  submitDonorName: (...args: unknown[]) => mockSubmit(...args),
}));

async function mount(node: ReactNode) {
  const view = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>{node}</PaperProvider>
    </SafeAreaProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
  return view;
}

const setLedger = (patch: Partial<ReturnType<typeof useSupportStore.getState>>) =>
  useSupportStore.setState({
    totalCents: 0,
    tipCount: 0,
    transactionIds: [],
    donorSubmitted: false,
    hydrated: true,
    ...patch,
  });

const COSTS = (donors: CostsDocument['donors']): CostsDocument => ({
  year: 2026,
  goals: null,
  supporters: 0,
  updated: null,
  donors,
});

beforeEach(async () => {
  mockParams = {};
  mockCosts = null;
  useSettingsStore.getState().reset();
  await useSettingsStore.getState().hydrate();
  useRecorderStore.setState({ status: 'idle' });
  setLedger({});
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

describe('Thank-you screen: donors offer', () => {
  it('is offered right after a Patron tip', async () => {
    mockParams = { tip: 'tip_patron' };
    setLedger({ totalCents: 9999, tipCount: 1 });
    await mount(<SupportThanksScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Add your name to the donors list'));
    });
    expect(mockPush).toHaveBeenCalledWith('/support/donor');
  });

  it('is offered once the total crosses $100, not before', async () => {
    mockParams = { tip: 'tip_large' };
    setLedger({ totalCents: 8500, tipCount: 4 });
    const view = await mount(<SupportThanksScreen />);
    expect(screen.queryByText('Add your name to the donors list')).toBeNull();
    await act(async () => {
      setLedger({ totalCents: 10000, tipCount: 5 });
    });
    view.rerender(
      <PaperProvider>
        <SupportThanksScreen />
      </PaperProvider>,
    );
    expect(screen.getByText('Add your name to the donors list')).toBeTruthy();
  });

  it('is not offered again after a name was sent', async () => {
    mockParams = { tip: 'tip_patron' };
    setLedger({ totalCents: 50000, tipCount: 5, donorSubmitted: true });
    await mount(<SupportThanksScreen />);
    expect(screen.queryByText('Add your name to the donors list')).toBeNull();
  });
});

describe('Donor form', () => {
  beforeEach(() => {
    setLedger({ totalCents: 10998, tipCount: 2, transactionIds: ['GPA.1', 'GPA.2'] });
  });

  it('asks for consent in plain words', async () => {
    await mount(<DonorFormScreen />);
    expect(screen.getByTestId('donor-consent')).toHaveTextContent(
      'Your name will be shown publicly in the app and on the website.',
    );
  });

  it('requires a name', async () => {
    await mount(<DonorFormScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Add my name'));
    });
    expect(screen.getByText('Please enter the name to show.')).toBeTruthy();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('sends the name, place, platform and receipts, then thanks', async () => {
    mockSubmit.mockResolvedValue('sent');
    await mount(<DonorFormScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Name to show'), '  Anne T. ');
    });
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Town or region, optional'), 'Rimouski');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Add my name'));
    });
    expect(mockSubmit).toHaveBeenCalledWith({
      name: 'Anne T.',
      place: 'Rimouski',
      platform: expect.stringMatching(/^(ios|android)$/),
      transactionIds: ['GPA.1', 'GPA.2'],
    });
    expect(screen.getByTestId('donor-sent')).toBeTruthy();
    expect(useSupportStore.getState().donorSubmitted).toBe(true);
  });

  it('says so calmly when the server cannot be reached', async () => {
    mockSubmit.mockResolvedValue('offline');
    await mount(<DonorFormScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Name to show'), 'Anne');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Add my name'));
    });
    expect(screen.getByText(/Couldn't reach our server/)).toBeTruthy();
    expect(useSupportStore.getState().donorSubmitted).toBe(false);
  });
});

describe('Prominent donors in System info', () => {
  it('is hidden while the published list is empty', async () => {
    mockCosts = { doc: COSTS([]), fromCache: false };
    await mount(<DonorsList />);
    expect(screen.queryByTestId('donors-list')).toBeNull();
  });

  it('lists the published names', async () => {
    mockCosts = {
      doc: COSTS([
        { name: 'Anne T.', place: 'Rimouski', since: 2026 },
        { name: 'Luc B.', place: null, since: 2026 },
      ]),
      fromCache: true,
    };
    await mount(<DonorsList />);
    expect(screen.getByText('Prominent donors')).toBeTruthy();
    expect(screen.getByText('Anne T.')).toBeTruthy();
    expect(screen.getByText('Rimouski · since 2026')).toBeTruthy();
    expect(screen.queryByText(/Add your name/)).toBeNull();
  });

  it('shows the way to add a name to someone whose tips qualify', async () => {
    setLedger({ totalCents: 12000, tipCount: 3 });
    await mount(<DonorsList />);
    await act(async () => {
      fireEvent.press(screen.getByText('Add your name to the donors list →'));
    });
    expect(mockPush).toHaveBeenCalledWith('/support/donor');
  });
});
