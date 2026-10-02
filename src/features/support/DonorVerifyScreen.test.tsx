/** "I already donated" (#476, round 3): email → code → a year without the tip button. */
import { TIP_JAR_REST_MS, VERIFY_CODE_TTL_MS } from '@core/support/verify';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DonorVerifyScreen } from './DonorVerifyScreen';

const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), dismissTo: mockDismissTo }),
}));
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

const mockStart = jest.fn();
const mockCheck = jest.fn();
jest.mock('@data/donorVerify', () => ({
  startDonorVerify: (...a: unknown[]) => mockStart(...a),
  checkDonorVerify: (...a: unknown[]) => mockCheck(...a),
}));

async function mount() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <DonorVerifyScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

async function type(label: string, text: string) {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText(label), text);
  });
}

async function press(text: string) {
  await act(async () => {
    fireEvent.press(screen.getByText(text));
  });
}

async function toCodeStep() {
  mockStart.mockResolvedValue('sent');
  await mount();
  await type('Email', ' Anne@Example.org ');
  await press('Send the code');
}

beforeEach(() => {
  useSettingsStore.setState({ tipJarRestingUntil: 0, hydrated: true });
  mockStart.mockReset();
  mockCheck.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('explains the honour system and what happens to the email', async () => {
  await mount();
  expect(screen.getByText(/used only to send the code/)).toBeTruthy();
  expect(screen.getByText(/on your honour/)).toBeTruthy();
});

it('checks the address before calling the server', async () => {
  await mount();
  await type('Email', 'not-an-email');
  await press('Send the code');
  expect(screen.getByText('Please check the email address.')).toBeTruthy();
  expect(mockStart).not.toHaveBeenCalled();
});

it('sends a code, then a right code rests the tip button for 12 months', async () => {
  await toCodeStep();
  expect(mockStart).toHaveBeenCalledWith('anne@example.org');
  expect(screen.getByTestId('verify-code-step')).toBeTruthy();
  mockCheck.mockResolvedValue('ok');
  await type('Code', '123 456');
  const before = Date.now();
  await press('Confirm');
  expect(mockCheck).toHaveBeenCalledWith('anne@example.org', '123456');
  expect(screen.getByTestId('verify-done')).toBeTruthy();
  const until = useSettingsStore.getState().tipJarRestingUntil;
  expect(until).toBeGreaterThanOrEqual(before + TIP_JAR_REST_MS);
  await press('Back to the map');
  expect(mockDismissTo).toHaveBeenCalledWith('/');
});

it('says so when the code is wrong, and keeps the button', async () => {
  await toCodeStep();
  mockCheck.mockResolvedValue('rejected');
  await type('Code', '000000');
  await press('Confirm');
  expect(screen.getByText(/does not match/)).toBeTruthy();
  expect(useSettingsStore.getState().tipJarRestingUntil).toBe(0);
});

it('says the code has expired after 15 minutes', async () => {
  const realNow = Date.now();
  const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);
  await toCodeStep();
  nowSpy.mockReturnValue(realNow + VERIFY_CODE_TTL_MS + 1);
  mockCheck.mockResolvedValue('rejected');
  await type('Code', '123456');
  await press('Confirm');
  expect(screen.getByText(/has expired/)).toBeTruthy();
});

it('asks for six digits before calling the server', async () => {
  await toCodeStep();
  await type('Code', '12');
  await press('Confirm');
  expect(screen.getByText('The code has six digits.')).toBeTruthy();
  expect(mockCheck).not.toHaveBeenCalled();
});

it.each([
  ['rate-limited', /Too many codes/],
  ['offline', /Couldn't reach our server/],
])('reports a %s start calmly', async (result, message) => {
  mockStart.mockResolvedValue(result);
  await mount();
  await type('Email', 'a@b.ca');
  await press('Send the code');
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.getByTestId('verify-email-step')).toBeTruthy();
});

it.each([
  ['rate-limited', /Too many tries/],
  ['offline', /Couldn't reach our server/],
])('reports a %s check calmly', async (result, message) => {
  await toCodeStep();
  mockCheck.mockResolvedValue(result);
  await type('Code', '123456');
  await press('Confirm');
  expect(screen.getByText(message)).toBeTruthy();
});

it('lets the person start over with another email', async () => {
  await toCodeStep();
  await press('Use another email or send a new code');
  expect(screen.getByTestId('verify-email-step')).toBeTruthy();
});
