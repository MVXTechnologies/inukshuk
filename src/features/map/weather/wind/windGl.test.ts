import { WIND_SHADER_PROGRAMS } from './windGl';

/**
 * GLSL ES 1.00 stage-linkage lint for the wind shaders. A varying that a
 * shader READS but never DECLARES compiles nowhere — the M3 particle overlay
 * shipped dead because UPDATE_FRAG used `v_tex_pos` without declaring it, the
 * update program failed to compile, the WindGl constructor threw, and the
 * overlay's catch degraded to "gradient only" in silence. No GL context is
 * needed to catch that class of bug: it is textual.
 */

/** `varying <type> <name>;` declarations in one shader source. */
function declaredVaryings(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\bvarying\s+(\w+)\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[2] !== undefined && m[1] !== undefined) out.set(m[2], m[1]);
  }
  return out;
}

/** Identifiers using the repo's `v_` varying naming convention. */
function referencedVaryings(src: string): Set<string> {
  const body = src.replace(/\bvarying\s+\w+\s+\w+\s*;/g, '');
  return new Set(body.match(/\bv_\w+/g) ?? []);
}

describe('wind shader stage linkage', () => {
  const programs = Object.entries(WIND_SHADER_PROGRAMS);

  it.each(programs)(
    '%s: every varying used in a stage is declared there',
    (_name, { vert, frag }) => {
      for (const src of [vert, frag]) {
        const declared = declaredVaryings(src);
        for (const used of referencedVaryings(src)) {
          expect(declared.has(used)).toBe(true);
        }
      }
    },
  );

  it.each(programs)('%s: shared varyings agree on type across stages', (_name, { vert, frag }) => {
    const inVert = declaredVaryings(vert);
    const inFrag = declaredVaryings(frag);
    for (const [name, type] of inFrag) {
      // A fragment varying must be produced by the vertex stage, same type.
      expect(inVert.get(name)).toBe(type);
    }
  });

  it('update program declares the quad texture coordinate (the M3 regression)', () => {
    const update = WIND_SHADER_PROGRAMS.update;
    expect(update).toBeDefined();
    expect(declaredVaryings(update?.frag ?? '').get('v_tex_pos')).toBe('vec2');
  });
});
