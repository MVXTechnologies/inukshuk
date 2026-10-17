import { DEVICE_EXTENSIONS } from '@core/extensions/registry';
import { ReceiverChipView } from '@features/gnss/ReceiverChipView';
import { useReceiverChip } from '@features/gnss/useReceiverChip';
import { useGnssStore } from '@state/gnssStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text } from '@ui/paper';

import {
  SectionTitle,
  SubPanelHeader,
  SwitchRow,
  useSheetAccent,
} from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionSubPanelProps } from '../types';
import {
  GnssCorrectionsOption,
  GnssDatumOption,
  GnssFallbackOption,
  GnssReceiverOption,
  GnssStandbyOption,
} from './options';
import { useScaledStyles } from '@ui/displayScale';

/**
 * Map overlays › Extensions › External GNSS receiver (#668): the live status
 * (the receiver chip, "Live view ›" to the receiver sheet), the switch, then
 * the receiver, corrections, datum and phone-GPS options — the Settings
 * options themselves (`./options`). A row into a screen closes the sheet;
 * pairing stays on its own screen (scanning needs permissions and a
 * long-running state the sheet handles badly).
 */
export function GnssSubPanel({ onBack, onClose }: ExtensionSubPanelProps) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const { show, installedAt } = useExtensionPrefs('gnss');
  const hydrated = useGnssStore((s) => s.hydrated);
  const chip = useReceiverChip();
  const { label } = DEVICE_EXTENSIONS.gnss;

  // The config is read from disk on first use (as Settings does).
  useEffect(() => {
    if (installedAt > 0 && !hydrated) void useGnssStore.getState().hydrate();
  }, [installedAt, hydrated]);

  const openLiveView = () => {
    onClose();
    useGnssStore.getState().setSheetOpen(true);
  };

  return (
    <>
      <SubPanelHeader title={label} backLabel="Back to extensions" onBack={onBack} />
      <View style={[styles.card, { backgroundColor: tokens.surfaceVariant }]}>
        <View style={styles.cardTop}>
          {chip !== null ? (
            <ReceiverChipView chip={chip} variant="surface" testID="gnss-panel-chip" />
          ) : (
            <Text style={[styles.cardTitle, { color: tokens.ink }]} numberOfLines={1}>
              {show ? 'Not connected' : 'Off · the phone’s own GPS'}
            </Text>
          )}
          <View style={styles.flex} />
          {chip !== null && (
            <Button
              mode="text"
              compact
              icon="chevron-right"
              contentStyle={styles.liveViewContent}
              textColor={accent}
              onPress={openLiveView}
              accessibilityLabel="Live view"
            >
              Live view
            </Button>
          )}
        </View>
        {chip !== null && chip.detail !== null && (
          <Text style={[styles.cardLine, { color: tokens.inkMuted }]} numberOfLines={1}>
            {chip.detail}
          </Text>
        )}
      </View>
      <SwitchRow
        icon="satellite-variant"
        label="Use the receiver"
        hint="Your location uses it while its fix is good"
        value={show}
        onToggle={() => setExtensionPrefs('gnss', { show: !show })}
        accessibilityLabel="Use the external receiver"
      />
      <SectionTitle>Receiver</SectionTitle>
      <GnssReceiverOption variant="sheet" onLeave={onClose} />
      <SectionTitle>Corrections & datum</SectionTitle>
      <GnssCorrectionsOption variant="sheet" onLeave={onClose} />
      <GnssDatumOption variant="sheet" onLeave={onClose} />
      <SectionTitle>Phone GPS</SectionTitle>
      <GnssFallbackOption variant="sheet" />
      <GnssStandbyOption variant="sheet" />
    </>
  );
}

const stylesSheet = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 4, marginBottom: 8, padding: 12, borderRadius: 14 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  cardTitle: { fontSize: 15, lineHeight: 20, fontWeight: '700', flexShrink: 1 },
  cardLine: { fontSize: 12.5, lineHeight: 17, marginTop: 4 },
  flex: { flex: 1 },
  // The chevron after the words, as the mockup's "Live view ›".
  liveViewContent: { flexDirection: 'row-reverse' },
});
