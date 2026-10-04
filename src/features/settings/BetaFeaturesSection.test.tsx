/** Settings › Beta features: the registry's switches, off by default, persisted. */
import { BETA_FEATURES, BETA_FEATURES_NOTE } from '@core/settings/betaFeatures';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { BetaFeaturesSection } from './BetaFeaturesSection';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

afterEach(() => {
  useSettingsStore.getState().reset();
});

function renderSection(): Promise<RenderResult> {
  return render(
    <PaperProvider>
      <BetaFeaturesSection />
    </PaperProvider>,
  );
}

it('explains betas and lists every registered one', async () => {
  const r = await renderSection();
  expect(r.getByText(BETA_FEATURES_NOTE)).toBeTruthy();
  for (const f of BETA_FEATURES) expect(r.getByText(f.title)).toBeTruthy();
});

it('3D terrain is off by default and the switch turns it on', async () => {
  const r = await renderSection();
  const sw = r.getByLabelText('3D terrain (beta)');
  expect(sw.props.value).toBe(false);
  await act(async () => {
    fireEvent(sw, 'valueChange', true);
  });
  expect(useSettingsStore.getState().betaTerrain3d).toBe(true);
});
