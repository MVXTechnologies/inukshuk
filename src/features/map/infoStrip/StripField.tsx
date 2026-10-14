import { sameValue } from '@core/infoStrip/compute';
import { VALUE_SP } from '@core/infoStrip/fit';
import { CAPTION_SP, fitCell, unfittedCell } from '@core/infoStrip/subject';
import type { StripSubject, StripValue } from '@core/infoStrip/types';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useMemo, useState } from 'react';
import { PixelRatio, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { WaypointPinView } from '../waypoints/WaypointPinView';
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
  /**
   * The strip lets this field name what it reads to (`captionPlan`): a
   * subject is named once per strip, its other fields show its icon only.
   */
  caption?: boolean;
  /** Test ids: the field's box, its text (2.5.1's chip ids live on for the coordinates). */
  testID?: string;
  textTestID?: string;
}

/**
 * THE renderer of every strip field (mockup `sfield`): what it reads to (its
 * subject's icon, and its name when the cell has room: `@core/infoStrip/
 * subject`), an optional tag ("ETE", "δ"), an optional glyph, the value in
 * bold tabular figures, the unit smaller and muted. Tone `ok` is sage, `warn`
 * amber.
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
  caption = true,
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
        ? fitCell(given, width, PixelRatio.getFontScale(), caption)
        : unfittedCell(given),
    [fit, width, given, caption],
  );
  const value = fitted.value;
  const subject = given.subject;
  const captioned = fitted.subject === 'caption';
  const ink = muted
    ? t.inkMuted
    : value.tone === 'ok'
      ? t.status.gnssFixed
      : value.tone === 'warn'
        ? t.status.pausedInk
        : t.ink;
  return (
    <View style={[styles.field, fit && styles.fill]} testID={testID} onLayout={onLayout}>
      {subject !== undefined && fitted.subject !== 'none' && (
        <SubjectIcon subject={subject} color={muted ? t.inkMuted : t.inkVariant} />
      )}
      {subject !== undefined && captioned && (
        <Text
          style={[styles.caption, { color: muted ? t.inkMuted : t.inkVariant }]}
          numberOfLines={1}
          ellipsizeMode="tail"
          testID="strip-subject-caption"
        >
          {subject.name}
        </Text>
      )}
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
          // Beside a caption, the caption gives way: only a name is ever cut.
          captioned && styles.whole,
        ]}
        numberOfLines={1}
        // The last resort when fitted: the native text shrinks rather than cut.
        adjustsFontSizeToFit={shrink || fitted.shrinkToFit}
        minimumFontScale={fitted.shrinkToFit ? 0.7 : 0.85}
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

/**
 * What a reading is to, as the map draws it: a saved waypoint's own pin (its
 * icon, in its colour), else the target's glyph in the theme's ink.
 * Decorative: the cell's label names it.
 */
function SubjectIcon({ subject, color }: { subject: StripSubject; color: string }) {
  return (
    <View
      style={styles.subjectIcon}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      testID={subject.pin === undefined ? 'strip-subject-glyph' : 'strip-subject-pin'}
    >
      {subject.pin === undefined ? (
        <Icon source={glyphIcon(subject.glyph)} size={14} color={color} />
      ) : (
        <WaypointPinView icon={subject.pin.icon} color={subject.pin.color} diameter={PIN_DP} />
      )}
    </View>
  );
}

/** The subject's pin head, dp: the glyph's 14 dp box, its tip inside the 30 dp row. */
const PIN_DP = 12;

function propsEqual(a: StripFieldProps, b: StripFieldProps): boolean {
  return (
    sameValue(a.value, b.value) &&
    a.caption === b.caption &&
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
  caption: { fontSize: CAPTION_SP, fontWeight: '600', flexShrink: 1, minWidth: 0 },
  whole: { flexShrink: 0 },
  subjectIcon: { width: 14, alignItems: 'center', justifyContent: 'center' },
  // Android clips an italic run's last glyph at the text's edge ("−14.6ᶜ"):
  // a hair of end padding leaves it room.
  muted: { fontStyle: 'italic', fontWeight: '600', paddingRight: 2 },
  fill: { flexGrow: 1, alignSelf: 'stretch' },
});
