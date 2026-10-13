import { StyleSheet } from 'react-native';

/**
 * The Settings › Extensions rows' shared layout, for the extensions' own rows
 * (coverage & sources…). Its own module so a surface that reuses those rows
 * (the overlays sheet's sub-panels) does not load the Settings shell.
 */
export const extensionRowStyles = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  flex: { flex: 1 },
  note: { marginTop: 8 },
  sources: { paddingHorizontal: 16, paddingBottom: 8, gap: 2 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
});
