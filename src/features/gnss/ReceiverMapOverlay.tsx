import { useGnssStore } from '@state/gnssStore';
import { StyleSheet, View } from 'react-native';

import { ReceiverChipView } from './ReceiverChipView';
import { ReceiverSheet } from './ReceiverSheet';
import { useReceiverChip } from './useReceiverChip';

/**
 * The receiver on the map (#588): its status chip in the top-centre lane
 * (below the destination / night / marine chip when one is up) and, when
 * tapped, its detail sheet. While recording, the panel's own chip takes the
 * chip's place (`showChip` false) and opens the same sheet.
 */
export function ReceiverMapOverlay({ top, showChip }: { top: number; showChip: boolean }) {
  const chip = useReceiverChip();
  const sheetOpen = useGnssStore((s) => s.sheetOpen);
  const setSheetOpen = useGnssStore((s) => s.setSheetOpen);
  if (chip === null) return null;
  return (
    <>
      {showChip && !sheetOpen && (
        <View style={[styles.lane, { top }]} pointerEvents="box-none">
          <ReceiverChipView
            chip={chip}
            variant="chrome"
            onPress={() => setSheetOpen(true)}
            testID="gnss-receiver-chip"
          />
        </View>
      )}
      {sheetOpen && <ReceiverSheet chip={chip} />}
    </>
  );
}

const styles = StyleSheet.create({
  // MapScreen's top-centre lane: between the compass stack and the controls rail.
  lane: { position: 'absolute', left: 76, right: 76, alignItems: 'center', zIndex: 5 },
});
