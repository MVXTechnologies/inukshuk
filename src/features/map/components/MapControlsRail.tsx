import type { OverlayRow } from '@core/map/overlayTabs';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { MapActionsMenu, type MapActions } from './MapActionsMenu';
import { MapButton } from './MapButton';
import { MapOverlaysMenu } from './MapOverlaysMenu';
import { useScaledStyles } from '@ui/displayScale';
import { useMapChrome } from '../useMapChrome';

interface Props {
  /** Distance from the top of the screen (safe-area inset + margin). */
  top: number;
  /** Whether the camera follows the user's position. */
  following: boolean;
  /** Start following (and zoom to a useful "where am I" level). */
  onLocate: () => void;
  /** Stop following, leaving the camera where it is. */
  onStopFollowing: () => void;
  /** Shown only when at least one PDF overlay is active. */
  showFitControl: boolean;
  onFit: () => void;
  pdfOverlayCount: number;
  trackOverlayCount: number;
  /**
   * The "+" map actions, the last button of the rail. undefined hides the
   * button entirely (recording under way, region select, category sheet
   * up) — 'Map actions' then leaves the a11y tree.
   */
  actions?: MapActions;
  /**
   * Compact map chrome: whether the chevron rail is unfolded. Owned by
   * MapScreen because it also gates other chrome; when compact, the "+"
   * actions button only shows while the controls are out (it lives here).
   */
  compactOpen: boolean;
  onCompactOpenChange: (open: boolean) => void;
  /** Any of the rail's sheets (Map layers, "+" actions) opened or closed. */
  onMenuOpenChange?: (open: boolean) => void;
  /**
   * The 3D/2D button (Settings → Beta features → 3D terrain only; undefined
   * hides it): `is3d` = the map is tilted, so the button offers 2D.
   */
  viewToggle?: { is3d: boolean; onPress: () => void };
  /**
   * Open the Map layers sheet on a row (the slope legend chip opens Slope's
   * page, #723): each new `seq` is one request.
   */
  overlaysRequest?: { row: OverlayRow; seq: number } | null;
}

/**
 * Right-side map controls (revamp `Main.html`, decision 2), top to bottom:
 * the target button (go to my position; tap again to stop following), Fit
 * map while PDF overlays are up, Map overlays (the Map layers sheet, which
 * holds the base map since #669 — the "Base map" button is gone), then "+".
 * Every button is a 48 dp {@link MapButton}; the Maestro labels ('Locate',
 * 'Fit map', 'Map overlays', 'Map actions', 'Map controls', 'Hide map
 * controls') are unchanged.
 */
export function MapControlsRail(props: Props) {
  const styles = useScaledStyles(stylesSheet);
  const chrome = useMapChrome();
  const column = { right: chrome.edgeInset, gap: chrome.railGap };

  const compact = useSettingsStore((s) => s.compactMapChrome);
  const { compactOpen, onCompactOpenChange } = props;
  // The Map layers sheet and the "+" actions sheet are plain-View sheets in
  // the rail's own column; ONE open at a time, owned here so an outside tap
  // on the backdrop below closes whichever is up.
  const [openMenu, setOpenMenu] = useState<null | 'overlays' | 'actions'>(null);
  // The row the sheet opens on (a request from the map), else its remembered tab.
  const [openOn, setOpenOn] = useState<OverlayRow | undefined>(undefined);
  const request = props.overlaysRequest ?? null;
  const [handledSeq, setHandledSeq] = useState<number | null>(request?.seq ?? null);
  if (request !== null && request.seq !== handledSeq) {
    setHandledSeq(request.seq);
    setOpenOn(request.row);
    setOpenMenu('overlays');
  }
  const { onMenuOpenChange } = props;
  useEffect(() => {
    onMenuOpenChange?.(openMenu !== null);
  }, [openMenu, onMenuOpenChange]);
  // A request while the chrome is folded unfolds it first.
  useEffect(() => {
    if (openMenu !== null && compact && !compactOpen) onCompactOpenChange(true);
  }, [openMenu, compact, compactOpen, onCompactOpenChange]);

  const { top, following, onLocate, onStopFollowing, showFitControl, onFit, actions } = props;

  // Compact map chrome: everything folded behind one chevron until asked.
  if (compact && !compactOpen) {
    return (
      <View style={[styles.rightControls, column, { top }]} pointerEvents="box-none">
        <MapButton
          icon="chevron-left"
          onPress={() => onCompactOpenChange(true)}
          accessibilityLabel="Map controls"
        />
      </View>
    );
  }

  return (
    <>
      {openMenu !== null && <Pressable style={styles.backdrop} onPress={() => setOpenMenu(null)} />}
      <View
        style={[styles.rightControls, column, styles.railAboveBackdrop, { top }]}
        pointerEvents="box-none"
      >
        {compact && (
          <MapButton
            icon="chevron-right"
            onPress={() => onCompactOpenChange(false)}
            accessibilityLabel="Hide map controls"
          />
        )}
        {/* Decision 2: a target, first in the rail. Idle it recentres and
            starts following; while following it is solid with the river-blue
            ink and a filled centre, and a tap stops following. */}
        <MapButton
          icon={following ? 'crosshairs-gps' : 'crosshairs'}
          selected={following}
          onPress={following ? onStopFollowing : onLocate}
          accessibilityLabel="Locate"
        />
        {props.viewToggle !== undefined && (
          <MapButton
            icon={props.viewToggle.is3d ? 'video-2d' : 'video-3d'}
            onPress={props.viewToggle.onPress}
            accessibilityLabel={props.viewToggle.is3d ? 'Switch to 2D view' : 'Switch to 3D view'}
          />
        )}
        {showFitControl && (
          <MapButton icon="fit-to-page-outline" onPress={onFit} accessibilityLabel="Fit map" />
        )}
        <MapOverlaysMenu
          open={openMenu === 'overlays'}
          onToggle={(o) => {
            setOpenOn(undefined);
            setOpenMenu(o ? 'overlays' : null);
          }}
          openOn={openOn}
        />
        {/* The "+" folds away while the Map layers sheet is up: under a tall
            sheet it was pushed onto the attribution chip (#484 emulator
            pass). It is back the moment the sheet closes. */}
        {actions !== undefined && openMenu !== 'overlays' && (
          <MapActionsMenu
            actions={actions}
            open={openMenu === 'actions'}
            onToggle={(o) => setOpenMenu(o ? 'actions' : null)}
          />
        )}
      </View>
    </>
  );
}

const stylesSheet = StyleSheet.create({
  // The rail's column (`@core/map/mapChrome`): the team SOS button shares its
  // axis (#756). Its inset and gap come from useMapChrome (#760): 48 dp touch
  // boxes that touch, their 40 dp discs 8 dp apart, all at the Display size.
  rightControls: {
    position: 'absolute',
    alignItems: 'flex-end',
  },
  // While a sheet is up, the rail must stack above its backdrop.
  railAboveBackdrop: { zIndex: 5 },
  backdrop: { ...StyleSheet.absoluteFill, zIndex: 4 },
});
