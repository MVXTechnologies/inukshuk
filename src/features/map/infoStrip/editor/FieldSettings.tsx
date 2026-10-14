import { formatCoordinate } from '@core/convert/coordinateDisplay';
import { haversineMeters } from '@core/geo/geomath';
import type { Slot } from '@core/infoStrip/edit';
import { fieldDescriptor } from '@core/infoStrip/registry';
import type {
  AnyParamSpec,
  ComputeContext,
  DepsSnapshot,
  InfoStrip,
  Params,
  ParamValue,
  Target,
} from '@core/infoStrip/types';
import { useLibraryStore } from '@state/libraryStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Fragment, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';

import {
  SectionTitle,
  Segmented,
  SheetNote,
  SubPanelHeader,
  SwitchRow,
  useSheetAccent,
} from '../../components/mapSheet';
import { StripField } from '../StripField';
import { previewValue } from './preview';

/** A choice with more options than this is a list of rows, not a segmented control. */
const SEGMENTED_MAX = 4;
/** The waypoint list's length (nearest first). */
const WAYPOINTS_SHOWN = 30;

const TOGGLE_ICON: Record<string, string> = {
  tapToCopy: 'content-copy',
  showAccuracy: 'crosshairs-gps',
};

type TargetKind = Target['kind'];

/**
 * A field's settings page (mockup §3 `cfgDist` / `cfgCoords`), GENERATED from
 * its params schema: a choice is a segmented control (a list when it has
 * many options), a toggle a switch row, a target the target picker. The row
 * it sits in is previewed on top, live.
 *
 * Targets (owner Q4): the page edits the strip's shared target, which every
 * target field follows; "Only this field" gives this one its own.
 */
export function FieldSettings({
  strip,
  at,
  data,
  ctx,
  onParams,
  onStripTarget,
  onBack,
}: {
  strip: InfoStrip;
  at: Slot;
  data: DepsSnapshot;
  ctx: ComputeContext;
  onParams: (params: Params) => void;
  onStripTarget: (target: Target) => void;
  onBack: () => void;
}) {
  const t = useSchemeTokens();
  const f = strip.rows[at.row]?.[at.index];
  const d = f === undefined ? undefined : fieldDescriptor(f.field);
  if (f === undefined || d === undefined) return null;
  const params = f.params as Params;
  const set = (key: string, value: ParamValue) => onParams({ ...params, [key]: value });

  return (
    <View>
      <SubPanelHeader title={d.label} backLabel="Back to info strip" onBack={onBack} />
      <View style={[styles.preview, { backgroundColor: t.surfaceVariant }]}>
        {strip.rows[at.row]!.map((g, i) => {
          const pv = previewValue(g, data, ctx);
          if (pv === null) return null;
          return (
            <View
              key={`${g.field}-${i}`}
              style={[
                styles.previewCell,
                { flex: pv.descriptor.spaces },
                i === at.index && { borderColor: t.ink },
              ]}
            >
              <StripField value={pv.value} shrink={pv.descriptor.spaces > 1} />
            </View>
          );
        })}
      </View>
      <Text style={[styles.summary, { color: t.inkMuted }]}>{d.summary}</Text>
      {Object.entries(d.params as Record<string, AnyParamSpec>).map(([key, spec]) => (
        <Fragment key={key}>
          {spec.kind === 'toggle' ? (
            <SwitchRow
              icon={TOGGLE_ICON[key] ?? 'tune-variant'}
              label={spec.label}
              hint={spec.hint}
              value={params[key] === true}
              onToggle={() => set(key, params[key] !== true)}
            />
          ) : spec.kind === 'choice' ? (
            <ChoiceParam spec={spec} value={params[key] as string} onSelect={(v) => set(key, v)} />
          ) : (
            <TargetParam
              label={spec.label}
              own={(params[key] as Target | null | undefined) ?? null}
              strip={strip.target}
              data={data}
              onOwn={(target) => set(key, target)}
              onStrip={onStripTarget}
            />
          )}
        </Fragment>
      ))}
    </View>
  );
}

function ChoiceParam({
  spec,
  value,
  onSelect,
}: {
  spec: Extract<AnyParamSpec, { kind: 'choice' }>;
  value: string;
  onSelect: (v: string) => void;
}) {
  const t = useSchemeTokens();
  const { accent } = useSheetAccent();
  return (
    <>
      <SectionTitle>{spec.label}</SectionTitle>
      {spec.options.length <= SEGMENTED_MAX ? (
        <View style={styles.pad}>
          <Segmented levels={spec.options} selected={value} onSelect={onSelect} />
        </View>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel={spec.label}>
          {spec.options.map((o) => {
            const on = o.value === value;
            return (
              <Pressable
                key={o.value}
                onPress={() => onSelect(o.value)}
                accessibilityRole="radio"
                accessibilityLabel={o.label}
                accessibilityState={{ checked: on, selected: on }}
                style={styles.radio}
              >
                <Icon
                  source={on ? 'radiobox-marked' : 'radiobox-blank'}
                  size={20}
                  color={on ? accent : t.inkMuted}
                />
                <Text style={[styles.radioText, { color: t.ink }]}>{o.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {spec.hint !== undefined && (
        <Text style={[styles.hint, { color: t.inkMuted }]}>{spec.hint}</Text>
      )}
    </>
  );
}

function TargetParam({
  label,
  own,
  strip,
  data,
  onOwn,
  onStrip,
}: {
  label: string;
  own: Target | null;
  strip: Target;
  data: DepsSnapshot;
  onOwn: (t: Target | null) => void;
  onStrip: (t: Target) => void;
}) {
  const t = useSchemeTokens();
  const { accent } = useSheetAccent();
  const waypoints = useLibraryStore((s) => s.waypoints);
  const effective = own ?? strip;
  const write = (next: Target) => (own !== null ? onOwn(next) : onStrip(next));
  const here = data.position ?? data.centre;
  const nearest = useMemo(
    () =>
      here === null
        ? waypoints.slice(0, WAYPOINTS_SHOWN)
        : [...waypoints]
            .sort((a, b) => haversineMeters(here, a) - haversineMeters(here, b))
            .slice(0, WAYPOINTS_SHOWN),
    [waypoints, here],
  );
  const firstWaypoint = nearest[0];
  const point =
    effective.kind === 'coordinate' ? effective.point : (data.centre ?? data.position ?? null);

  // Only the kinds that can name something now (no greyed options).
  const kinds: { value: TargetKind; label: string }[] = [
    { value: 'navTarget', label: 'Nav. target' },
    { value: 'nextOnTrail', label: 'Next on trail' },
  ];
  if (firstWaypoint !== undefined || effective.kind === 'waypoint') {
    kinds.push({ value: 'waypoint', label: 'Waypoint' });
  }
  if (point !== null) kinds.push({ value: 'coordinate', label: 'Coordinate' });

  const select = (kind: TargetKind) => {
    if (kind === effective.kind) return;
    if (kind === 'waypoint') write({ kind, waypointId: firstWaypoint!.id });
    else if (kind === 'coordinate') write({ kind, point: point! });
    else write({ kind });
  };

  return (
    <>
      <SectionTitle>{label}</SectionTitle>
      <View style={styles.pad}>
        <Segmented levels={kinds} selected={effective.kind} onSelect={select} />
      </View>
      {effective.kind === 'waypoint' &&
        nearest.map((w) => {
          const on = w.id === effective.waypointId;
          return (
            <Pressable
              key={w.id}
              onPress={() => write({ kind: 'waypoint', waypointId: w.id })}
              accessibilityRole="radio"
              accessibilityLabel={w.label}
              accessibilityState={{ checked: on, selected: on }}
              style={styles.radio}
            >
              <Icon
                source={on ? 'radiobox-marked' : 'map-marker-outline'}
                size={20}
                color={on ? accent : t.inkMuted}
              />
              <Text style={[styles.radioText, { color: t.ink }]} numberOfLines={1}>
                {w.label}
              </Text>
            </Pressable>
          );
        })}
      {effective.kind === 'coordinate' && (
        <View style={styles.coordRow}>
          <Text style={[styles.coordText, { color: t.ink }]} numberOfLines={1}>
            {formatCoordinate(
              effective.point.latitude,
              effective.point.longitude,
              data.coordinateFormat,
            )}
          </Text>
          {data.centre !== null && (
            <Button
              mode="text"
              icon="image-filter-center-focus"
              onPress={() => write({ kind: 'coordinate', point: data.centre! })}
              accessibilityLabel="Use the map centre"
            >
              Map centre
            </Button>
          )}
        </View>
      )}
      <SheetNote icon="information-outline">
        {own === null
          ? 'Every target field in the strip shares this target, unless you pick another for it.'
          : 'This field measures to its own target; the others follow the strip’s.'}
      </SheetNote>
      <SwitchRow
        icon="target"
        label="Only this field"
        hint={own === null ? 'Follows the strip’s target' : 'Its own target'}
        value={own !== null}
        onToggle={() => onOwn(own === null ? strip : null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    padding: 4,
    borderRadius: 10,
  },
  previewCell: {
    height: 30,
    minWidth: 0,
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  summary: { fontSize: 12.5, marginHorizontal: 16, marginTop: 6 },
  pad: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6 },
  hint: { fontSize: 12, marginHorizontal: 16, marginBottom: 4 },
  radio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  radioText: { fontSize: 15, flex: 1 },
  coordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 8,
  },
  coordText: { flex: 1, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
