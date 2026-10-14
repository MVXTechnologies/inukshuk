/**
 * A catalog row's credit lines (#680): a Cartes Plein-air map names its
 * author and says it is free on the publisher's site, in light and dark, and
 * in French on a French device. An ordinary map shows neither.
 */
import { schemeTokens } from '@ui/tokens';
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { CatalogItemRow, type CatalogItemRowProps } from './CatalogItemRow';
import { cpaMap, cpaSource, fixtureIndex, lacBeauport } from './explore/exploreTestUtils';

const mockLanguage = jest.fn<'fr' | 'en', []>(() => 'en');
jest.mock('../map/search/deviceLanguage', () => ({
  deviceSearchLanguage: () => mockLanguage(),
}));

const noop = () => undefined;

function mount(props: Partial<CatalogItemRowProps>, dark = false) {
  return render(
    <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>
      <CatalogItemRow
        item={cpaMap}
        source={cpaSource}
        installStatus="not-installed"
        downloading={false}
        expanded={false}
        units="metric"
        onToggleExpand={noop}
        onDownload={noop}
        onUpdate={noop}
        onOpen={noop}
        onCancel={noop}
        {...props}
      />
    </PaperProvider>,
  );
}

beforeEach(() => mockLanguage.mockReturnValue('en'));

it.each([false, true])('credits the author and says the map is free (dark: %s)', async (dark) => {
  const view = await mount({}, dark);
  const credit = view.getByText('Auteur Exemple · 2022 · Cartes Plein-air');
  const free = view.getByText('Available free at cartespleinair.org');
  const muted = schemeTokens(dark).inkMuted;
  expect(StyleSheet.flatten(credit.props.style).color).toBe(muted);
  expect(StyleSheet.flatten(free.props.style).color).toBe(muted);
  expect(view.queryByText(/\$|Buy|Purchase/)).toBeNull();
});

it('says it in French on a French device', async () => {
  mockLanguage.mockReturnValue('fr');
  const view = await mount({});
  expect(view.getByText('Disponible gratuitement sur cartespleinair.org')).toBeTruthy();
});

it('an ordinary map keeps its source caption and no free line', async () => {
  const view = await mount({ item: lacBeauport, source: fixtureIndex().sources[0] });
  expect(view.getByText('NRCan CanTopo')).toBeTruthy();
  expect(view.queryByText(/free at/)).toBeNull();
});
