/**
 * The GNSS output-datum validation vectors (`fixtures/datum-vectors.json`):
 * GNSS scenarios (a fix kind, a correction frame, a project datum) with
 * official-tool answers (NRCan TRX / GPS·H, NOAA NCAT), the exact pipeline
 * `datum.ts` must plan for each, and PROJ's frozen result on it. Shared by
 * the always-on Jest gate and the host-PROJ gate.
 */
import type { CompareKind } from '../convert/suite';
import type { CorrectionFrame } from './casters';
import { planFixOutput, receiverFrame, type OutputPlanResult, type ProjectDatum } from './datum';
import type { FixKind } from './quality';

export interface DatumVector {
  id: string;
  title: string;
  scenario: { kind: FixKind; corrections: CorrectionFrame | null | 'none'; project: ProjectDatum };
  /** [lon, lat, h] as the receiver reports it. */
  input: [number, number, number];
  obsEpoch: number;
  expected: [number | null, number | null, number | null];
  tol: { h: number | null; v: number | null };
  source: { tool: string; date: string; [k: string]: unknown };
  pipeline: string;
  inDim: 2 | 3 | 4;
  validation: string[];
  /** PROJ 9.8.1 on `pipeline`, frozen. */
  proj: [number, number, number];
}

export interface DatumVectorFile {
  _meta: Record<string, unknown>;
  vectors: DatumVector[];
}

/** UTC ms of a decimal-year epoch (the vectors' observation time). */
export function epochToMs(t: number): number {
  const y = Math.floor(t);
  const a = Date.UTC(y, 0, 1);
  return a + (t - y) * (Date.UTC(y + 1, 0, 1) - a);
}

/** The plan `datum.ts` makes for a vector's scenario today. */
export function planVector(v: DatumVector): OutputPlanResult {
  const [lon, lat, hEll] = v.input;
  return planFixOutput(
    { lat, lon, hEll, timeMs: epochToMs(v.obsEpoch) },
    receiverFrame(v.scenario.kind, v.scenario.corrections),
    v.scenario.project,
  );
}

/** How `expected` is compared (null entries are skipped by `deltas`). */
export const VECTOR_COMPARE: readonly CompareKind[] = ['lon', 'lat', 'h'];
