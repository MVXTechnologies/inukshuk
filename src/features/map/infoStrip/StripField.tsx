import { sameValue } from '@core/infoStrip/compute';
import { fitStripValue, VALUE_SP } from '@core/infoStrip/fit';
import type { StripValue } from '@core/infoStrip/types';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useMemo, useState } from 'react';
import { PixelRatio, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { glyphIcon } from './glyphs';

export interface StripFieldProps {
  value: StripValue;
  /** Coordinates and the like: one type step smaller before they ellipsise. */
  shrink?: boolean;
  /**
   * Not a live value (the editor's "—" placeholder, a preset's sample): drawn
   * muted and italic so it never reads as a reading (QA 2.6.0).
   */
  muted?: boolean;
  /**
   * The field fills a cell of known width (the strip's, the editor's chips):
   * it fits itself to it (`fitStripValue`: tag, a type step, unit detail,
   * glyph, then native shrinking), so a value is never cut (QA 2.6.0). Off
   * for content-sized boxes (the picker), where fitting would chase itself.
   */
  fit?: boolean;
  /** Test ids: the field's box, its text (2.5.1's chip ids live on for the coordinates). */
  testID?: string;
  textTestID?: string;
}

/**
 * THE renderer of every strip field (mockup `sfield`): an optional tag
 * ("ETE", "δ"), an optional glyph, the value in bold tabular figures, the
 * unit smaller and muted. Tone `ok` is sage, `warn` amber.
 *
 * Memoised on the value's CONTENT (`sameValue`): compute() returns a fresh
 * object each tick, and a field whose text did not change must not render.
 * Pure display: no hooks beyond the theme and its own cell width, no subscriptions.
 */
export const StripField = memo(function StripField({
  value: given,
  shrink = false,
  muted = false,
  fit = false,
  testID,
  textTestID,
}: StripFieldProps) {
  const t = useSchemeTokens();
  // The cell's width, once laid out (one extra render, then only on resize).
  const [width, setWidth] = useState<number | null>(null);
  const onLayout = fit
    ? (e: LayoutChangeEvent) => {
        const w = Math.round(e.nativeEvent.layout.width);
        setWidth((old) => (old === w ? old : w));
      }
    : undefined;
  const fitted = useMemo(
    () =>
      fit && width !== null
        ? fitStripValue(given, width, PixelRatio.getFontScale())
        : { value: given, valueSp: VALUE_SP },
    [fit, width, given],
  );
  const value = fitted.value;
  const ink = muted
    ? t.inkMuted
    : value.tone === 'ok'
      ? t.status.gnssFixed
      : value.tone === 'warn'
        ? t.status.pausedInk
        : t.ink;
  return (
    <View style={[styles.field, fit && styles.fill]} testID={testID} onLayout={onLayout}>
      {value.tag !== undefined && (
        <Text style={[styles.tag, { color: t.inkMuted }]} numberOfLines={1}>
          {value.tag}
        </Text>
      )}
      {value.glyph !== undefined && (
        <Icon
          source={glyphIcon(value.glyph)}
          size={14}
          color={value.tone === undefined ? t.inkVariant : ink}
        />
      )}
      <Text
        style={[
          styles.value,
          { color: ink },
          fitted.valueSp !== VALUE_SP && { fontSize: fitted.valueSp },
          muted && styles.muted,
        ]}
        numberOfLines={1}
        // The last resort when fitted: the native text shrinks rather than cut.
        adjustsFontSizeToFit={shrink || fit}
        minimumFontScale={fit ? 0.7 : 0.85}
        testID={textTestID}
      >
        {value.value}
        {value.unit !== undefined && value.unit !== '' && (
          <Text style={[styles.unit, { color: t.inkMuted }]}> {value.unit}</Text>
        )}
      </Text>
    </View>
  );
}, propsEqual);

function propsEqual(a: StripFieldProps, b: StripFieldProps): boolean {
  return (
    sameValue(a.value, b.value) &&
    a.shrink === b.shrink &&
    a.muted === b.muted &&
    a.fit === b.fit &&
    a.testID === b.testID &&
    a.textTestID === b.textTestID
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0, flexShrink: 1 },
  tag: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.3 },
  value: {
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  unit: { fontSize: 11, fontWeight: '500' },
  muted: { fontStyle: 'italic', fontWeight: '600' },
  fill: { flexGrow: 1, alignSelf: 'stretch' },
});
