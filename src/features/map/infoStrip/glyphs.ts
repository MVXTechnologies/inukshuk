import type { FieldGroup } from '@core/infoStrip/types';

/**
 * The fields name their glyphs in Material Symbols (the mockup's set, kept in
 * the pure core); the app draws MaterialCommunityIcons. One table, so a new
 * field's glyph is one line here. An unknown name draws a small dot rather
 * than a broken icon.
 */
const GLYPHS: Readonly<Record<string, string>> = {
  filter_center_focus: 'image-filter-center-focus',
  my_location: 'crosshairs-gps',
  terrain: 'terrain',
  landscape: 'image-filter-hdr',
  gps_fixed: 'crosshairs',
  flag: 'flag-variant',
  route: 'routes',
  place: 'map-marker',
  explore: 'compass-outline',
  navigation: 'navigation-variant-outline',
  speed: 'speedometer',
  sailing: 'sail-boat',
  wb_twilight: 'weather-sunset-down',
  check_circle: 'check-circle',
  wrong_location: 'map-marker-alert-outline',
  timer: 'timer-outline',
  straighten: 'ruler',
  north_east: 'arrow-top-right',
  south_east: 'arrow-bottom-right',
  directions_walk: 'walk',
  satellite_alt: 'satellite-variant',
  waves: 'waves',
};

export function glyphIcon(name: string): string {
  return GLYPHS[name] ?? 'circle-small';
}

/** The picker's group chips and section titles (mockup §3). */
export const GROUP_LABEL: Record<FieldGroup, string> = {
  navigation: 'Navigation',
  position: 'Position',
  motion: 'Motion',
  recording: 'Recording',
  extension: 'Extensions',
};

/** A field's icon in the picker when its sample has no glyph. */
export const GROUP_ICON: Record<FieldGroup, string> = {
  navigation: 'compass-outline',
  position: 'map-marker-outline',
  motion: 'speedometer',
  recording: 'record-circle-outline',
  extension: 'puzzle-outline',
};
