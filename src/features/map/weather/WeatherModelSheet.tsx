import {
  modelCaption,
  WEATHER_MODELS,
  weatherModelById,
  type WeatherModelId,
} from '@core/weather/weatherModels';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import { weatherChrome as wc } from './weatherChrome';

/**
 * Forecast-model picker (weather UX M2, the Windy source-row idiom): a
 * compact dark translucent sheet floating above the time scrubber — one pill
 * per ECCC model with its resolution + horizon subscript ("2.5 km · 48 h"),
 * the selected pill ringed and tinted in the accent, and a "Compare models"
 * row at the bottom opening the per-point comparison table.
 *
 * Plain themed View, never a Paper Surface (the absolutely-positioned
 * Surface flex collapse on iOS) and never a Portal (the sheet lives in the
 * weather dock's flex column, so it can't soft-lock anything). Fixed dark
 * chrome in both themes like the rest of the weather chrome.
 *
 * A11y/Maestro: model rows are labelled "Model HRDPS" etc. — the prefix
 * matters because 'HRDPS' contains 'RDPS', so bare wrapped matchers would
 * cross-match. "Compare models" only exists here while the sheet is open
 * (the scrubber caption echoes the model NAME, so names are not open-state
 * sentinels — this row is).
 *
 * Wave B (worldwide weather): `effective` is the model the drape actually
 * resolved to at the viewport centre. Inside the selected model's domain it
 * equals `selected` and nothing changes. Outside (HRDPS/RDPS are
 * Canada-domain), the GDPS pill wears a soft "in use" ring beside the
 * selection ring and a hint row says why — honest, no error, and the
 * selection itself is untouched so panning home restores it.
 */
export function WeatherModelSheet({
  selected,
  effective,
  onSelect,
  onCompare,
}: {
  selected: WeatherModelId;
  /** The model the drape resolved to here (== selected inside coverage). */
  effective?: WeatherModelId;
  onSelect: (id: WeatherModelId) => void;
  onCompare: () => void;
}) {
  const resolved = effective ?? selected;
  const fallback = resolved !== selected;
  return (
    <View style={styles.sheet}>
      <Text style={styles.title}>FORECAST MODEL</Text>
      <View style={styles.pillRow}>
        {WEATHER_MODELS.map((m) => {
          const active = m.id === selected;
          const auto = fallback && m.id === resolved;
          return (
            <TouchableRipple
              key={m.id}
              onPress={() => onSelect(m.id)}
              accessibilityLabel={`Model ${m.label}`}
              accessibilityState={{ selected: active }}
              style={[styles.pill, active && styles.pillActive, auto && styles.pillAuto]}
              borderless
            >
              <View style={styles.pillInner}>
                <Text style={[styles.pillName, active && styles.pillNameActive]}>{m.label}</Text>
                <Text style={[styles.pillSub, active && styles.pillSubActive]} numberOfLines={1}>
                  {auto ? 'in use here' : modelCaption(m)}
                </Text>
              </View>
            </TouchableRipple>
          );
        })}
      </View>
      {fallback && (
        <Text style={styles.autoHint}>
          Outside {weatherModelById(selected).label} coverage here — showing{' '}
          {weatherModelById(resolved).label} (global)
        </Text>
      )}
      <View style={styles.divider} />
      <TouchableRipple
        onPress={onCompare}
        accessibilityLabel="Compare models"
        style={styles.compareRow}
        borderless
      >
        <View style={styles.compareInner}>
          <Icon source="table-large" size={16} color={wc.inkMuted} />
          <Text style={styles.compareText}>Compare models</Text>
          <Icon source="chevron-right" size={18} color={wc.inkMuted} />
        </View>
      </TouchableRipple>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    alignSelf: 'flex-end',
    minWidth: 292,
    maxWidth: 360,
    backgroundColor: wc.panelSolid,
    borderRadius: 18,
    paddingTop: 10,
    paddingBottom: 2,
    paddingHorizontal: 10,
  },
  title: {
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 1.2,
    color: wc.inkFaint,
    marginLeft: 6,
    marginBottom: 8,
  },
  pillRow: { flexDirection: 'row', gap: 6 },
  pill: {
    flex: 1,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: wc.hairline,
    paddingVertical: 8,
  },
  pillActive: { borderColor: wc.accent, backgroundColor: 'rgba(182, 201, 138, 0.14)' },
  // The auto-resolved model outside the selection's domain: a soft ring —
  // present but visually subordinate to the selection's full accent ring.
  pillAuto: { borderColor: 'rgba(182, 201, 138, 0.55)' },
  autoHint: {
    fontSize: 11,
    lineHeight: 15,
    color: wc.inkMuted,
    marginTop: 8,
    marginHorizontal: 6,
  },
  pillInner: { alignItems: 'center', gap: 1 },
  pillName: { fontSize: 13, lineHeight: 16, fontWeight: '700', color: wc.inkMuted },
  pillNameActive: { color: wc.accent },
  pillSub: { fontSize: 10, lineHeight: 13, color: wc.inkFaint, fontVariant: ['tabular-nums'] },
  pillSubActive: { color: wc.inkMuted },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: wc.hairline, marginTop: 10 },
  compareRow: { borderRadius: 12 },
  compareInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  compareText: { flex: 1, fontSize: 13, lineHeight: 17, color: wc.ink },
});
