import {
  focusBbox,
  focusGeometry,
  initialStageIndex,
  nearestStage,
  stageTitle,
  stepStage,
  trailMarkers,
} from './stages';
import { QUEBEC_CITY, sampleDetail, STAGE_LINES } from './__fixtures__/trails';

describe('trail stages', () => {
  const detail = sampleDetail(true);
  const flat = sampleDetail(false);

  it('finds the stage nearest the user', () => {
    expect(nearestStage(detail.stages, [-70.64, 47.25])?.index).toBe(2);
    expect(nearestStage([], [0, 0])).toBeNull();
  });

  it('selects the nearby stage, else the first', () => {
    expect(initialStageIndex(detail, [-70.6, 47.3])).toBe(3);
    expect(initialStageIndex(detail, QUEBEC_CITY)).toBe(0);
    expect(initialStageIndex(detail, null)).toBe(0);
    expect(initialStageIndex(flat, null)).toBeNull();
  });

  it('steps within bounds', () => {
    expect(stepStage(detail, 0, -1)).toBe(0);
    expect(stepStage(detail, 2, 1)).toBe(3);
    expect(stepStage(detail, 3, 1)).toBe(3);
    expect(stepStage(detail, null, 1)).toBe(1);
    expect(stepStage(flat, 0, 1)).toBeNull();
  });

  it('frames the stage or the whole trail', () => {
    expect(focusGeometry(detail, 1)).toEqual(detail.stages[1]!.geometry);
    expect(focusGeometry(detail, null)).toBe(detail.geometry);
    expect(focusGeometry(detail, 9)).toBe(detail.geometry);
    const b = focusBbox(detail, 0);
    expect(b[0]).toBeCloseTo(STAGE_LINES[0]![0]![0], 5);
    expect(focusBbox({ ...flat, geometry: [] }, null)).toEqual(flat.bbox);
  });

  it('places start, finish and stage joins', () => {
    const m = trailMarkers(detail);
    expect(m.start?.[0]).toBeCloseTo(-70.754, 5);
    expect(m.finish?.[0]).toBeCloseTo(-70.571, 5);
    expect(m.joins).toHaveLength(3);
    // A loop has no separate finish.
    const loop = { ...flat, roundtrip: true };
    expect(trailMarkers(loop).finish).toBeNull();
  });

  it('titles stages', () => {
    expect(stageTitle(detail.stages[1]!, 1)).toBe('Stage 2 · Étape 2');
  });
});
