import { IMPERIAL, METRIC } from '@core/format';

const { deviceDefaultUnits } = jest.requireActual<typeof import('./deviceUnits')>('./deviceUnits');

const resolvedLocale = (locale: string) =>
  jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    () =>
      ({
        resolvedOptions: () => ({ locale }),
      }) as Intl.DateTimeFormat,
  );

afterEach(() => jest.restoreAllMocks());

it('reads miles and feet on a US device', () => {
  resolvedLocale('en-US');
  expect(deviceDefaultUnits()).toBe(IMPERIAL);
});

it('reads metric on a Canadian device', () => {
  resolvedLocale('fr-CA');
  expect(deviceDefaultUnits()).toBe(METRIC);
});

it('falls back to metric when Intl throws', () => {
  jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
    throw new Error('no Intl');
  });
  expect(deviceDefaultUnits()).toBe(METRIC);
});

it('is pinned to metric for the rest of the suite', () => {
  // jest.setup.ts mocks the module: the suite's defaults never follow LANG.
  const mocked = jest.requireMock<typeof import('./deviceUnits')>('./deviceUnits');
  expect(mocked.deviceDefaultUnits()).toBe(METRIC);
});
