/**
 * The accuracy panel (CONVERT §4, mockups 08–09): one line per operation —
 * its name, EPSG code, stated accuracy, grids and epochs — the input
 * precision, what it was validated against, and a status:
 *
 * - green: pinned operations whose combined stated accuracy is ≤ 0.1 m;
 * - amber: > 0.1 m, an accuracy nobody states, a station chart datum, a
 *   flagged step (velocity model v7 over > 1 cm, LN02 chain…), or an input
 *   that is less precise than the result looks;
 * - red: a refusal (the engine never shows a number then).
 */
import validationIndex from './fixtures/index.json';
import type { GridRef, Plan, Refusal, Step } from './types';

export type Status = 'green' | 'amber' | 'red';

export interface PanelLine {
  icon: 'ok' | 'warn' | 'error' | 'info';
  /** Bold lead ("±5 cm", "Input limits the result:"). */
  lead?: string;
  text: string;
}

export interface PanelGrid {
  file: string;
  label: string;
  bundled: boolean;
  available: boolean;
}

export interface AccuracyPanel {
  status: Status;
  /** Combined stated accuracy (RSS), metres; null when a step states none. */
  combinedM: number | null;
  headline: string;
  lines: PanelLine[];
  grids: PanelGrid[];
  /** "NRCan · OGL-Canada", one per agency. */
  credits: string[];
  /** Lines for "Copy all". */
  copyLines: string[];
}

interface IndexEntry {
  title: string;
  tools: string[];
  n: number;
  pass: number;
  known: number;
  diagnosis: string | null;
}
const INDEX = validationIndex as Record<string, IndexEntry>;

export function formatAccuracy(m: number): string {
  if (m === 0) return 'exact';
  if (m < 0.01) return `±${(m * 1000).toFixed(m < 0.001 ? 1 : 0)} mm`;
  if (m < 1) return `±${Math.round(m * 100)} cm`;
  return `±${m.toFixed(1)} m`;
}

/** Combined stated accuracy: root-sum-square of the steps; null if any is unknown. */
export function combinedAccuracy(steps: readonly Step[]): number | null {
  let sum = 0;
  for (const s of steps) {
    if (s.accuracyM === null) return null;
    sum += s.accuracyM * s.accuracyM;
  }
  return Math.sqrt(sum);
}

/** Short tool names ("NRCan TRX", "NOAA NCAT") for the steps' validation pairs. */
export function validatedAgainst(ids: readonly string[]): string[] {
  const tools = new Set<string>();
  for (const id of ids) {
    for (const t of INDEX[id]?.tools ?? []) tools.add(shortTool(t));
  }
  return [...tools];
}

function shortTool(t: string): string {
  return t
    .replace(/\s*\(.*$/, '')
    .replace(/ web service$/, '')
    .replace(/ API$/, '')
    .trim();
}

export interface PanelInput {
  /** Metres the typed input's last digit is worth (input precision). */
  inputPrecisionM: number | null;
  /** Grids present on the device. */
  available: (file: string) => boolean;
  /** Horizontal displacement the velocity grid applied, metres (TRAP 7 rule). */
  epochShiftM?: number;
  /** Heights given by a station offset, for the label. */
  epochIn?: number;
  epochOut?: number;
}

/** Amber when the v7 velocity model moved the point by more than this. */
export const EPOCH_AMBER_M = 0.01;
/** The input only matters when coarser than this. */
export const INPUT_AMBER_M = 0.02;

export function buildPanel(plan: Plan, input: PanelInput): AccuracyPanel {
  const ops = plan.steps.filter((s) => s.accuracyM !== 0 || s.epsgOp || s.grids.length > 0);
  const combined = combinedAccuracy(plan.steps);
  let amber = combined === null || combined > 0.1;
  const lines: PanelLine[] = [];
  const copy: string[] = [];

  for (const s of ops) {
    const acc = s.accuracyM === null ? 'accuracy not stated' : formatAccuracy(s.accuracyM);
    const code = s.epsgOp ? ` (EPSG:${s.epsgOp})` : '';
    const epochs =
      s.epochIn !== undefined && s.epochOut !== undefined
        ? ` · epoch ${s.epochIn.toFixed(2)} → ${s.epochOut.toFixed(2)}`
        : '';
    const stepAmber = s.accuracyM === null || s.accuracyM > 0.1 || s.flag === 'amber';
    lines.push({ icon: stepAmber ? 'warn' : 'ok', lead: acc, text: `${s.name}${code}${epochs}` });
    copy.push(`Op: ${s.name}${code}, ${acc}${epochs}`);
    if (s.note) lines.push({ icon: 'info', text: s.note });
    if (s.flag === 'amber') amber = true;
  }
  if (ops.length === 0) {
    lines.push({ icon: 'ok', lead: 'exact', text: 'A change of notation or map projection only' });
    copy.push('Op: conversion only (exact)');
  }

  if (input.epochShiftM !== undefined) {
    const big = input.epochShiftM > EPOCH_AMBER_M;
    if (big) amber = true;
    lines.push({
      icon: big ? 'warn' : 'ok',
      lead: `${(input.epochShiftM * 100).toFixed(1)} cm`,
      text: `moved by the NAD83(CSRS) velocity grid v7${big ? ' — more than 1 cm, so TRX (v8) may differ by a few mm to cm' : ''}`,
    });
  }

  if (input.inputPrecisionM !== null && input.inputPrecisionM > INPUT_AMBER_M) {
    amber = true;
    lines.push({
      icon: 'warn',
      lead: 'Input limits the result:',
      text: `the last digit you typed is worth ${formatAccuracy(input.inputPrecisionM).replace('±', '≈ ±')}. Type more decimals for mm results.`,
    });
  }

  const tools = validatedAgainst(plan.validation);
  if (tools.length > 0) {
    lines.push({ icon: 'ok', text: `Validated against ${tools.join(', ')}` });
    copy.push(`Validated against: ${tools.join('; ')}`);
  }
  const grids: PanelGrid[] = [];
  const agencies = new Map<string, string>();
  for (const s of plan.steps) {
    for (const g of s.grids) {
      if (!grids.some((x) => x.file === g.file)) grids.push(panelGrid(g, input.available(g.file)));
      agencies.set(g.agency, g.licence);
    }
  }
  if (grids.some((g) => !g.available)) amber = true;

  const status: Status = amber ? 'amber' : 'green';
  const headline =
    combined === null
      ? 'Accuracy not stated for one step'
      : `${formatAccuracy(combined)} (stated, combined)`;
  copy.unshift(`Accuracy: ${headline}`);
  return {
    status,
    combinedM: combined,
    headline,
    lines,
    grids,
    credits: [...agencies].map(([a, l]) => `${a} · ${l}`),
    copyLines: copy,
  };
}

function panelGrid(g: GridRef, available: boolean): PanelGrid {
  return { file: g.file, label: g.label, bundled: g.bundled, available };
}

/** The red panel for a refusal. */
export function refusalPanel(r: Refusal): AccuracyPanel {
  return {
    status: 'red',
    combinedM: null,
    headline: 'Refused',
    lines: [{ icon: 'error', lead: 'Refused:', text: r.message }],
    grids: (r.grids ?? []).map((file) => ({ file, label: file, bundled: false, available: false })),
    credits: [],
    copyLines: [`Refused: ${r.message}`],
  };
}
