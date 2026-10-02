/**
 * The "Your organisation's maps aren't here?" card: the address is shown as
 * text, Copy puts it on the clipboard and says so, and the GitHub path opens
 * a prefilled issue.
 */
import { ORG_MAPS_CONTACT_EMAIL, orgMapsIssueUrl } from '@core/catalog/contribute';
import { act, fireEvent } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Linking } from 'react-native';

import { mountWithProviders } from './exploreTestUtils';
import { COPIED_FEEDBACK_MS, OrganisationMapsCta } from './OrganisationMapsCta';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));

afterEach(() => {
  jest.useRealTimers();
});

it('shows the address as text, never only as a mail link', async () => {
  const view = await mountWithProviders(<OrganisationMapsCta />);
  expect(view.getByText(ORG_MAPS_CONTACT_EMAIL)).toBeTruthy();
  expect(view.getByText('Your organisation’s maps aren’t here?')).toBeTruthy();
});

it('copies the address and confirms, then resets', async () => {
  jest.useFakeTimers();
  const view = await mountWithProviders(<OrganisationMapsCta />);
  await fireEvent.press(view.getByLabelText('Copy the email address'));
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(ORG_MAPS_CONTACT_EMAIL);
  expect(view.getByText('Copied')).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(COPIED_FEEDBACK_MS + 10);
  });
  expect(view.getByText('Copy')).toBeTruthy();
});

it('opens a prefilled GitHub issue', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  const view = await mountWithProviders(<OrganisationMapsCta />);
  await fireEvent.press(view.getByLabelText('Suggest a map source on GitHub'));
  expect(open).toHaveBeenCalledWith(orgMapsIssueUrl());
  open.mockRestore();
});
