import {
  STREAK_ALPHA_CEIL,
  STREAK_ALPHA_FLOOR,
  STREAK_ALPHA_GAIN,
  STREAK_EXCESS_GAIN,
  STREAK_KNEE_MPS,
  STREAK_MAX_MPS,
} from '@core/weather/windLook';
import { glslFloat, WIND_SHADER_PROGRAMS } from './windGl';

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

/**
 * The visual constants are interpolated from @core/weather/windLook rather
 * than typed into the GLSL twice. GLSL ES 1.00 has no implicit int→float
 * conversion, so an integer-valued constant rendered as `5` instead of `5.0`
 * is a COMPILE error — which kills the whole renderer silently, exactly the
 * failure mode the linkage tests above exist for.
 */
describe('interpolated tuning constants', () => {
  it('renders every interpolated constant as a GLSL float literal', () => {
    // GLSL ES 1.00 float literals: a decimal point, or an exponent.
    const isGlslFloat = (s: string): boolean => /^-?(\d+\.\d*|\.\d+|\d+[eE][+-]?\d+)$/.test(s);
    for (const n of [
      STREAK_KNEE_MPS,
      STREAK_EXCESS_GAIN,
      STREAK_MAX_MPS,
      STREAK_ALPHA_FLOOR,
      STREAK_ALPHA_GAIN,
      STREAK_ALPHA_CEIL,
    ]) {
      expect(isGlslFloat(glslFloat(n))).toBe(true);
    }
    // The trap this guards: an integer-valued constant must not render bare.
    expect(glslFloat(5)).toBe('5.0');
    expect(glslFloat(0.25)).toBe('0.25');
  });

  it('carries the compression knee, gain and ceiling into the update shader', () => {
    const update = WIND_SHADER_PROGRAMS.update?.frag ?? '';
    expect(update).toContain(glslFloat(STREAK_KNEE_MPS));
    expect(update).toContain(glslFloat(STREAK_EXCESS_GAIN));
    expect(update).toContain(glslFloat(STREAK_MAX_MPS));
    // The compression must be applied AFTER the gust boost, or the ×3 gust
    // subset keeps drawing the smears the cap exists to remove.
    expect(update.indexOf('boost')).toBeLessThan(update.indexOf('adv_mps'));
  });

  it('carries the flattened alpha ramp into the draw shader', () => {
    const draw = WIND_SHADER_PROGRAMS.draw?.frag ?? '';
    expect(draw).toContain(glslFloat(STREAK_ALPHA_FLOOR));
    expect(draw).toContain(glslFloat(STREAK_ALPHA_GAIN));
    expect(draw).toContain(glslFloat(STREAK_ALPHA_CEIL));
  });
});
