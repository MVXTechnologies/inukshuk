/**
 * Correction profiles: where corrections come from and — the part that
 * matters for coordinates — which reference frame and epoch they put the
 * rover in. A sourcetable never says; the profile does, from a preset or the
 * user. When nobody knows, the fix is treated as WGS 84 with a visible
 * "frame unknown" warning (owner decision A5, 2026-10-06).
 *
 * The "Québec (MRNF, free)" raw-TCP preset is P2 (owner A10) and not here.
 */
import { FRAMES } from '../convert/systems';
import type { FrameId } from '../convert/types';
import type { DatumTransform } from './rtcm3';

/** A coordinate epoch: a decimal year, or "the epoch of the observation" (current-epoch services). */
export type EpochSpec = number | 'observation';

export interface CorrectionFrame {
  frame: FrameId;
  /** Required for dynamic frames (NAD83(CSRS), ITRF); ignored for static ones. */
  epoch?: EpochSpec;
}

export interface CasterPreset {
  id: string;
  label: string;
  host: string;
  port: number;
  version: 1 | 2;
  /** The frame the service's corrections are in; null = it depends on the base (ask its owner). */
  frame: CorrectionFrame | null;
  note: string;
  /** Where the frame claim comes from. */
  source: string;
}

export const CASTER_PRESETS: readonly CasterPreset[] = [
  {
    id: 'rtk2go',
    label: 'RTK2go (community bases)',
    host: 'rtk2go.com',
    port: 2101,
    version: 1,
    frame: null,
    note: 'Free; each base declares its own frame (ask the base owner). User name = your e-mail, password "none".',
    source: 'http://rtk2go.com/how-to-connect/',
  },
  {
    id: 'emlid',
    label: 'Emlid Caster (your own base)',
    host: 'caster.emlid.com',
    port: 2101,
    version: 1,
    frame: null,
    note: 'Corrections are in the frame you gave your base’s coordinates in.',
    source: 'https://emlid.com/ntrip-caster/',
  },
  {
    id: 'polaris',
    label: 'Point One Polaris',
    host: 'polaris.pointonenav.com',
    port: 2101,
    version: 2,
    frame: { frame: 'itrf2014', epoch: 'observation' },
    note: 'Subscription; ITRF2014 at the current epoch.',
    source: 'https://support.pointonenav.com/what-is-the-ntrip-configuration',
  },
];

export function presetById(id: string): CasterPreset | undefined {
  return CASTER_PRESETS.find((p) => p.id === id);
}

/** "NAD83(CSRS) 1997.0", "ITRF2014 (current epoch)", "WGS 84". */
export function frameLabel(f: CorrectionFrame): string {
  const fr = FRAMES[f.frame];
  if (!fr.dynamic) return fr.name;
  if (f.epoch === undefined) return `${fr.name} (epoch?)`;
  return f.epoch === 'observation'
    ? `${fr.name} (current epoch)`
    : `${fr.name} ${f.epoch.toFixed(1)}`;
}

/** Whether a correction frame is complete enough to convert from (dynamic frames need an epoch). */
export function frameComplete(f: CorrectionFrame): boolean {
  return !FRAMES[f.frame].dynamic || f.epoch !== undefined;
}

/**
 * What an RTCM 1021/1022 transformation message says, for display next to
 * the profile's frame. Never applied: the network's own parameters are not
 * a validated operation (GNSS.md §3.1).
 */
export interface DatumHint {
  sourceName: string;
  targetName: string;
  systemId: number;
  text: string;
}

export function datumHint(t: DatumTransform): DatumHint {
  const src = t.sourceName.trim() || '?';
  const dst = t.targetName.trim() || '?';
  return {
    sourceName: src,
    targetName: dst,
    systemId: t.systemId,
    text: `The network announces ${src} → ${dst} (RTCM ${t.type}); shown for information, not applied.`,
  };
}
