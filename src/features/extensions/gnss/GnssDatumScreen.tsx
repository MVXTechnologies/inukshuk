import { formatAccuracy } from '@core/gnss/chip';
import { correctionsOf } from '@core/gnss/config';
import { planFixOutput, receiverFrame, type OutputPlanResult } from '@core/gnss/datum';
import { PROJECT_DATUM_OPTIONS, type ProjectDatumOption } from '@core/gnss/projectDatum';
import { useGnssStore } from '@state/gnssStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { RadioButton, Text } from 'react-native-paper';

import { GnssScreenFrame } from './GnssScreenFrame';

/** One line on whether Convert can take the current fix to `o`, and how well. */
export function routeLine(r: OutputPlanResult | null): { ok: boolean; text: string } | null {
  if (r === null) return null;
  if (!r.ok) return { ok: false, text: `Not from here: ${r.refusal.message}` };
  const acc = r.out.datumAccuracyM;
  return {
    ok: true,
    text: `${r.out.method}${acc === null ? '' : ` · conversion ${formatAccuracy(acc)}`}`,
  };
}

/**
 * Settings › External GNSS receiver › Project datum (owner A4): the frame,
 * epoch and heights the receiver sheet gives coordinates in. Each option says
 * whether Convert has a validated route to it from the current fix — and
 * which, with its stated accuracy — or why not. Never a guessed shift.
 */
export function GnssDatumScreen() {
  const t = useSchemeTokens();
  const config = useGnssStore((s) => s.config);
  const update = useGnssStore((s) => s.updateConfig);
  const fix = useGnssStore((s) => s.fix);
  // The fix's own UTC when the receiver sent a date, else when it arrived.
  const fixAt = useGnssStore((s) => s.fix?.timeMs ?? s.status?.lastFixAtMs ?? null);
  const fixKey = fix ? `${fix.kind}|${fix.lat.toFixed(3)}|${fix.lon.toFixed(3)}` : '';

  const routes = useMemo(() => {
    const out: Record<string, OutputPlanResult | null> = {};
    for (const o of PROJECT_DATUM_OPTIONS) {
      out[o.id] =
        fix === null
          ? null
          : planFixOutput(
              { lat: fix.lat, lon: fix.lon, hEll: fix.hEll, timeMs: fixAt ?? 0 },
              receiverFrame(fix.kind, correctionsOf(config)),
              o.datum,
            );
    }
    return out;
    // Re-plan when the fix moves ~100 m or changes kind, not on every epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixKey, config.activeProfileId, config.profiles]);

  const pick = (o: ProjectDatumOption) => update({ projectDatumId: o.id });

  return (
    <GnssScreenFrame title="Project datum" testID="gnss-datum-screen">
      <Text variant="bodyMedium" style={{ color: t.inkVariant }}>
        The coordinates the receiver sheet gives, with how they were converted and how accurate that
        is. The map itself always draws in WGS 84.
      </Text>
      <RadioButton.Group value={config.projectDatumId} onValueChange={() => undefined}>
        {PROJECT_DATUM_OPTIONS.map((o) => {
          const line = routeLine(routes[o.id] ?? null);
          const selected = o.id === config.projectDatumId;
          return (
            <Pressable
              key={o.id}
              onPress={() => pick(o)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={o.label}
              style={[styles.option, { borderColor: selected ? t.ink : t.outlineVariant }]}
            >
              <RadioButton value={o.id} onPress={() => pick(o)} />
              <View style={styles.flex}>
                <Text variant="titleSmall">{o.label}</Text>
                <Text variant="bodySmall" style={{ color: t.inkVariant }}>
                  {o.note}
                </Text>
                {line !== null && (
                  <Text
                    variant="bodySmall"
                    style={[styles.route, { color: line.ok ? t.inkMuted : t.status.gpsWeak }]}
                  >
                    {line.ok ? `✓ ${line.text}` : `⚠ ${line.text}`}
                  </Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </RadioButton.Group>
      <Text variant="bodySmall" style={{ color: t.inkMuted }}>
        {fix === null
          ? 'Each route is checked against your position once the receiver has a fix.'
          : 'Checked from your current fix. Only conversions validated against the agencies’ own tools (NRCan TRX and GPS·H, NOAA NCAT…) are offered; anything else is refused.'}
      </Text>
    </GnssScreenFrame>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
    paddingVertical: 10,
    paddingRight: 12,
    borderWidth: 1,
    borderRadius: 14,
    marginBottom: 8,
  },
  route: { marginTop: 4 },
});
