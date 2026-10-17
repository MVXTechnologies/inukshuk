/**
 * Settings → Extensions → Tide stations (`@core/map/tideStyle`):
 *
 * - not installed: what it is, and "Get";
 * - installed: the layer switch (also in Map overlays › Extensions), "Show
 *   levels on the map" while it is on (#764), Coverage & sources (stations
 *   per source; Canada live from CHS), Remove.
 *
 * Tidal benchmarks belong to Geodetic points (its Tidal chip), not here.
 */
import { tideCoverageSummary } from '@core/tides/coverage';
import { useState } from 'react';
import { List, useTheme } from '@ui/paper';

import { TideLegend } from '../../map/components/TideLegend';
import { tideImage } from '../../map/tideImages';
import { ExtensionSettingsShell } from '../ExtensionSettingsShell';
import { useExtensionPrefs } from '../prefs';
import { TideLevelsSettingsItem } from './TideLevelsRow';
import { TideSources, useTideCoverage } from './TideSources';

export function TideSettings() {
  const theme = useTheme();
  const { show } = useExtensionPrefs('tides');
  const coverage = useTideCoverage();
  const [sourcesOpen, setSourcesOpen] = useState(false);

  return (
    <ExtensionSettingsShell
      extKey="tides"
      badge={tideImage(theme.dark ? 'dark' : 'light', true)}
      badgeIconSize={20}
      description="Tide gauges with their published tidal levels in chart datum, the national datum and as ellipsoidal heights, and the live water level. Canada live from CHS."
      legend={<TideLegend />}
      note="Free · a few kB per offline region"
      showLabel="Show tide stations"
      removeDescription="Hides the layer"
      removeMessage="The stations leave the map. You can get them again any time."
    >
      {show && <TideLevelsSettingsItem />}
      <List.Item
        title="Tide coverage & sources"
        description={tideCoverageSummary(coverage)}
        descriptionNumberOfLines={2}
        onPress={() => setSourcesOpen((o) => !o)}
        right={(p) => <List.Icon {...p} icon={sourcesOpen ? 'chevron-up' : 'chevron-right'} />}
        accessibilityLabel="Tide coverage & sources"
      />
      {sourcesOpen && <TideSources coverage={coverage} />}
    </ExtensionSettingsShell>
  );
}
