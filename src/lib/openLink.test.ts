import * as Clipboard from 'expo-clipboard';
import { Alert, Linking } from 'react-native';

import { openExternalLink } from './openLink';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));

const URL = 'https://www.usgs.gov/programs/national-geospatial-program/us-topo-maps-america';

beforeEach(() => {
  jest.restoreAllMocks();
  jest.mocked(Clipboard.setStringAsync).mockClear();
  jest.mocked(Clipboard.setStringAsync).mockResolvedValue(true);
});

it('opens the link and says so', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  await expect(openExternalLink(URL)).resolves.toBe(true);
  expect(open).toHaveBeenCalledWith(URL);
  expect(alert).not.toHaveBeenCalled();
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
});

// #373: iOS refused ("Unable to open URL: …") and the rejection went unhandled.
it('never rejects when the OS refuses: copies the address and explains', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error(`Unable to open URL: ${URL}`));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  await expect(openExternalLink(URL)).resolves.toBe(false);
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(URL);
  expect(alert).toHaveBeenCalledWith(
    'Could not open the link',
    expect.stringContaining('The address was copied'),
  );
  expect(alert.mock.calls[0]?.[1]).toContain(URL);
});

it('still explains when the clipboard fails too', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('Unable to open URL'));
  jest.mocked(Clipboard.setStringAsync).mockRejectedValue(new Error('no clipboard'));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  await expect(openExternalLink(URL)).resolves.toBe(false);
  expect(alert.mock.calls[0]?.[1]).toContain(`Open this address in your browser:\n\n${URL}`);
});

it('ignores an empty address', async () => {
  const open = jest.spyOn(Linking, 'openURL');
  await expect(openExternalLink('  ')).resolves.toBe(false);
  expect(open).not.toHaveBeenCalled();
});
