/**
 * Windy-style wind particle renderer (weather M3) — a port of
 * mapbox/webgl-wind to expo-gl.
 *
 * Portions Copyright (c) 2016, Mapbox (ISC License):
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * The GPU technique is webgl-wind's verbatim (GLSL ES 1.00 / WebGL 1):
 * particle positions live RGBA-encoded in ping-pong state textures, a
 * fullscreen "update" pass advects them by a manually-bilinear wind-texture
 * sample, trails come from redrawing the previous frame at a fade opacity,
 * and particles render as GL_POINTS decoded from the state texture.
 *
 * Inukshuk adaptations (all deliberate, none change the technique):
 * - particles live in the WIND GRID's UV space (a WCS subset of the region,
 *   not the whole world) but SPAWN inside the visible viewport's sub-rect of
 *   that grid (see `viewportGridRect`); leaving the rect respawns them
 *   instead of wrapping. The grid is deliberately much larger than the
 *   viewport (fetch padding + a 0.5° floor), so grid-wide spawning would put
 *   all but ~3 of 2000 particles off-screen at trail zooms;
 * - advection is likewise screen-relative (`advectionUvPerMps`) so streak
 *   speed reads the same at every zoom instead of scaling with grid size;
 * - the trail buffer and the composite are PREMULTIPLIED alpha end to end;
 *   the fade pass scales rgb and alpha together, so a straight-alpha
 *   composite would darken the drape wherever a trail decays;
 * - the draw pass projects grid UV → mercator offsets → clip through a
 *   matrix built from the MapLibre ViewState (see @core/weather/windProjection;
 *   mercator y is computed relative to the grid's north edge as log(tanN/tanP)
 *   — float32-safe at deep zooms);
 * - advection converts m/s to grid UV per frame with the cos(lat) mercator
 *   distortion, so streak speed and length are proportional to wind speed;
 * - the gust mapping (owner-approved): a deterministic ~20% particle subset
 *   advects at the gust/speed ratio decoded from the texture's B channel —
 *   gusty areas read as sparse, faster, longer streaks;
 * - streaks are near-white translucent (alpha ∝ speed) over the colour
 *   drape — the underlay already encodes speed, Windy-style;
 * - a global opacity uniform lets the overlay fade during gestures.
 */

import type { GridRect } from '@core/weather/windProjection';

// expo-gl implements the WebGL 1 interface; the standard lib type is enough.
type GL = WebGLRenderingContext;

const QUAD_VERT = `
precision mediump float;
attribute vec2 a_pos;
varying vec2 v_tex_pos;
void main() {
  v_tex_pos = a_pos;
  gl_Position = vec4(1.0 - 2.0 * a_pos, 0, 1);
}
`;

const SCREEN_FRAG = `
precision mediump float;
uniform sampler2D u_screen;
uniform float u_opacity;
varying vec2 v_tex_pos;
void main() {
  vec4 color = texture2D(u_screen, 1.0 - v_tex_pos);
  // a hack to guarantee opacity fade out even with a value close to 1.0
  gl_FragColor = vec4(floor(255.0 * color * u_opacity) / 255.0);
}
`;

const UPDATE_FRAG = `
precision highp float;
uniform sampler2D u_particles;
uniform sampler2D u_wind;
uniform vec2 u_wind_res;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform float u_rand_seed;
uniform vec2 u_uv_per_mps;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;
uniform float u_lat_north;
uniform float u_lat_span;
uniform float u_gust_scale;
// The visible viewport as a grid-UV rect: particles spawn (and respawn) here,
// not across the whole fetched grid — the grid is up to ~600× the viewport's
// area at trail zooms, which would put all but a handful of particles
// off-screen.
uniform vec2 u_spawn_min;
uniform vec2 u_spawn_max;

// The quad vertex shader's texture coordinate. Declaring it here is NOT
// optional: GLSL ES 1.00 requires the varying in BOTH stages, and without it
// this program fails to compile — which took the whole renderer down.
varying vec2 v_tex_pos;

// pseudo-random generator
const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);
float rand(const vec2 co) {
  float t = dot(rand_constants.xy, co);
  return fract(sin(t) * (rand_constants.z + t));
}

// wind speed lookup; manual bilinear filtering for smooth interpolation
vec2 lookup_wind(const vec2 uv) {
  vec2 px = 1.0 / u_wind_res;
  vec2 vc = (floor(uv * u_wind_res)) * px;
  vec2 f = fract(uv * u_wind_res);
  vec2 tl = texture2D(u_wind, vc).rg;
  vec2 tr = texture2D(u_wind, vc + vec2(px.x, 0)).rg;
  vec2 bl = texture2D(u_wind, vc + vec2(0, px.y)).rg;
  vec2 br = texture2D(u_wind, vc + px).rg;
  return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

void main() {
  vec4 color = texture2D(u_particles, v_tex_pos);
  vec2 pos = vec2(
    color.r / 255.0 + color.b,
    color.g / 255.0 + color.a); // decode particle position from pixel RGBA

  vec2 velocity = mix(u_wind_min, u_wind_max, lookup_wind(pos));
  float speed_t = length(velocity) / length(u_wind_max);

  // gust subset: ~20% of particles (stable per state texel) advect at the
  // gust/speed ratio encoded in the B channel (0 → ×1, 1 → ×u_gust_scale).
  float gust_ratio = 1.0 + texture2D(u_wind, pos).b * (u_gust_scale - 1.0);
  float gusty = step(0.8, rand(v_tex_pos + 7.31));
  float boost = mix(1.0, gust_ratio, gusty);

  // mercator distortion for the east-west m/s → degrees conversion
  float lat = u_lat_north - pos.y * u_lat_span;
  float distortion = cos(radians(lat));
  vec2 offset = vec2(velocity.x / max(distortion, 0.05) * u_uv_per_mps.x,
                     -velocity.y * u_uv_per_mps.y) * boost;

  pos = pos + offset;

  // a random seed to use for the particle drop
  vec2 seed = (pos + v_tex_pos) * u_rand_seed;

  // drop rate is a chance a particle will restart at random position, to
  // avoid degeneration; leaving the SPAWN RECT (the padded viewport, already
  // clamped to the grid) forces the respawn
  float drop_rate = u_drop_rate + speed_t * u_drop_rate_bump;
  float drop = step(1.0 - drop_rate, rand(seed));
  float out_of_view = step(0.5,
    step(u_spawn_max.x, pos.x) + step(pos.x, u_spawn_min.x) +
    step(u_spawn_max.y, pos.y) + step(pos.y, u_spawn_min.y));
  drop = max(drop, out_of_view);

  vec2 random_pos = mix(u_spawn_min, u_spawn_max, vec2(rand(seed + 1.3), rand(seed + 2.1)));
  pos = mix(pos, random_pos, drop);

  // encode the new particle position back into RGBA
  gl_FragColor = vec4(fract(pos * 255.0), floor(pos * 255.0) / 255.0);
}
`;

const DRAW_VERT = `
precision highp float;
attribute float a_index;
uniform sampler2D u_particles;
uniform float u_particles_res;
uniform mat4 u_matrix;
uniform float u_lat_north;
uniform float u_lat_span;
uniform float u_lon_span;
uniform float u_point_size;

varying vec2 v_particle_pos;

const float PI = 3.141592653589793;

void main() {
  vec4 color = texture2D(u_particles, vec2(
    fract(a_index / u_particles_res),
    floor(a_index / u_particles_res) / u_particles_res));

  // decode current particle position from the pixel's RGBA value
  v_particle_pos = vec2(
    color.r / 255.0 + color.b,
    color.g / 255.0 + color.a);

  // grid UV → mercator offsets from the grid's NW corner. The y offset is
  // log(tanN/tanP)/2π = merc(lat) − merc(latN) (positive going south); the
  // ratio form stays accurate in float32 (operands ~1, the log is ~0).
  float lat = u_lat_north - v_particle_pos.y * u_lat_span;
  float tn = tan(PI * 0.25 + 0.5 * radians(u_lat_north));
  float tp = tan(PI * 0.25 + 0.5 * radians(lat));
  float rel_y = log(tn / tp) / (2.0 * PI);
  float rel_x = v_particle_pos.x * u_lon_span / 360.0;

  gl_PointSize = u_point_size;
  gl_Position = u_matrix * vec4(rel_x, rel_y, 0, 1);
}
`;

const DRAW_FRAG = `
precision mediump float;
uniform sampler2D u_wind;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
varying vec2 v_particle_pos;

void main() {
  vec2 velocity = mix(u_wind_min, u_wind_max, texture2D(u_wind, v_particle_pos).rg);
  float speed_t = length(velocity) / length(u_wind_max);
  // near-white translucent streak, brighter where the wind is stronger —
  // the colour information lives in the gradient drape underneath.
  // PREMULTIPLIED: the trail pass fades rgb and alpha together, so the whole
  // pipeline has to read as premultiplied or decayed trails composite as
  // BLACK over the drape instead of fading out.
  float a = 0.20 + 0.34 * speed_t;
  gl_FragColor = vec4(vec3(a), a);
}
`;

/**
 * Every shader program the renderer links, exported so the co-located test
 * can lint stage linkage without a GL context. A varying missing from one
 * stage is a compile error on real drivers but invisible in review — that
 * exact bug (UPDATE_FRAG lacking `varying vec2 v_tex_pos`) shipped M3 dead.
 */
export const WIND_SHADER_PROGRAMS: Record<string, { vert: string; frag: string }> = {
  draw: { vert: DRAW_VERT, frag: DRAW_FRAG },
  screen: { vert: QUAD_VERT, frag: SCREEN_FRAG },
  update: { vert: QUAD_VERT, frag: UPDATE_FRAG },
};

interface ProgramInfo {
  program: WebGLProgram;
  attrib: Record<string, number>;
  uniform: Record<string, WebGLUniformLocation | null>;
}

function createShader(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('wind: createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(String(gl.getShaderInfoLog(shader)));
  }
  return shader;
}

function createProgram(gl: GL, vert: string, frag: string): ProgramInfo {
  const program = gl.createProgram();
  if (program === null) throw new Error('wind: createProgram failed');
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(String(gl.getProgramInfoLog(program)));
  }
  const info: ProgramInfo = { program, attrib: {}, uniform: {} };
  const nAttr = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < nAttr; i++) {
    const a = gl.getActiveAttrib(program, i);
    if (a) info.attrib[a.name] = gl.getAttribLocation(program, a.name);
  }
  const nUni = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < nUni; i++) {
    const u = gl.getActiveUniform(program, i);
    if (u) info.uniform[u.name] = gl.getUniformLocation(program, u.name);
  }
  return info;
}

function createTexture(
  gl: GL,
  filter: number,
  data: Uint8Array,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (texture === null) throw new Error('wind: createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function bindTexture(gl: GL, texture: WebGLTexture, unit: number): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function bindAttribute(
  gl: GL,
  buffer: WebGLBuffer,
  attribute: number,
  numComponents: number,
): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, numComponents, gl.FLOAT, false, 0, 0);
}

function bindFramebuffer(
  gl: GL,
  framebuffer: WebGLFramebuffer | null,
  texture?: WebGLTexture,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  if (texture !== undefined) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  }
}

/** The wind data + georeferencing the renderer needs per field. */
export interface WindGlData {
  width: number;
  height: number;
  rgba: Uint8Array;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  /** Grid NORTH edge latitude, degrees. */
  latNorth: number;
  /** Grid latitude span, degrees (positive, extends south). */
  latSpanDeg: number;
  /** Grid longitude span, degrees (positive). */
  lonSpanDeg: number;
}

/** Tunables (webgl-wind heritage, values tuned for the trail-zoom look). */
// Owner call (2026-08-10): the 0.965 tails were dense enough to bury the
// coastlines and place names underneath. Shorter trails + a dimmer streak
// alpha below keep the flow readable while the geography stays legible.
const FADE_OPACITY = 0.93; // trail persistence per frame (short comet tails)
const DROP_RATE = 0.003;
const DROP_RATE_BUMP = 0.01;
const GUST_SCALE = 3; // matches GUST_RATIO_MAX in the encoder
const POINT_SIZE = 1.8;

export class WindGl {
  private readonly gl: GL;
  private readonly drawProgram: ProgramInfo;
  private readonly screenProgram: ProgramInfo;
  private readonly updateProgram: ProgramInfo;
  private readonly quadBuffer: WebGLBuffer;
  private readonly framebuffer: WebGLFramebuffer;

  private windTexture: WebGLTexture | null = null;
  private windData: WindGlData | null = null;
  private backgroundTexture: WebGLTexture | null = null;
  private screenTexture: WebGLTexture | null = null;
  private particleStateTexture0: WebGLTexture | null = null;
  private particleStateTexture1: WebGLTexture | null = null;
  private particleIndexBuffer: WebGLBuffer | null = null;
  private particleStateResolution = 0;
  private numParticles = 0;
  private screenWidth = 0;
  private screenHeight = 0;
  /** Full drawing-buffer size (the composite target). */
  private viewWidth = 0;
  private viewHeight = 0;
  /** Current trail-buffer scale (see resize). */
  private scale = 1;
  /** Physical-px multiplier for gl_PointSize (the GLView buffer is physical). */
  pointScale = 1;

  constructor(gl: GL) {
    this.gl = gl;
    this.drawProgram = createProgram(gl, DRAW_VERT, DRAW_FRAG);
    this.screenProgram = createProgram(gl, QUAD_VERT, SCREEN_FRAG);
    this.updateProgram = createProgram(gl, QUAD_VERT, UPDATE_FRAG);
    const quad = gl.createBuffer();
    const fb = gl.createFramebuffer();
    if (quad === null || fb === null) throw new Error('wind: buffer alloc failed');
    this.quadBuffer = quad;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.framebuffer = fb;
    this.resize();
  }

  /**
   * (Re)allocate the screen/trail textures. They are sized to the drawing
   * buffer times `resolutionScale`: the three fullscreen passes per frame are
   * the real cost on fill-rate-bound devices, so rendering them at half size
   * (and letting the composite upscale) is the throttle that actually works.
   * The composite still covers the full drawing buffer.
   */
  resize(scale = 1): void {
    const gl = this.gl;
    const w = Math.max(1, Math.round(gl.drawingBufferWidth * scale));
    const h = Math.max(1, Math.round(gl.drawingBufferHeight * scale));
    this.viewWidth = gl.drawingBufferWidth;
    this.viewHeight = gl.drawingBufferHeight;
    this.scale = scale;
    if (w === this.screenWidth && h === this.screenHeight && this.screenTexture !== null) return;
    this.screenWidth = w;
    this.screenHeight = h;
    const empty = new Uint8Array(w * h * 4);
    if (this.backgroundTexture) gl.deleteTexture(this.backgroundTexture);
    if (this.screenTexture) gl.deleteTexture(this.screenTexture);
    // LINEAR so an upscaled trail buffer composites smoothly instead of
    // showing the scaling as blocky streaks.
    this.backgroundTexture = createTexture(gl, gl.LINEAR, empty, w, h);
    this.screenTexture = createTexture(gl, gl.LINEAR, empty, w, h);
  }

  /** Clear the accumulated trails (gesture settle → fresh streaks). */
  clearTrails(): void {
    const gl = this.gl;
    for (const tex of [this.backgroundTexture, this.screenTexture]) {
      if (tex === null) continue;
      bindFramebuffer(gl, this.framebuffer, tex);
      gl.viewport(0, 0, this.screenWidth, this.screenHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    bindFramebuffer(gl, null);
  }

  setNumParticles(numParticles: number): void {
    const gl = this.gl;
    const res = (this.particleStateResolution = Math.ceil(Math.sqrt(numParticles)));
    this.numParticles = res * res;
    const state = new Uint8Array(this.numParticles * 4);
    for (let i = 0; i < state.length; i++) state[i] = Math.floor(Math.random() * 256);
    if (this.particleStateTexture0) gl.deleteTexture(this.particleStateTexture0);
    if (this.particleStateTexture1) gl.deleteTexture(this.particleStateTexture1);
    this.particleStateTexture0 = createTexture(gl, gl.NEAREST, state, res, res);
    this.particleStateTexture1 = createTexture(gl, gl.NEAREST, state, res, res);
    const indices = new Float32Array(this.numParticles);
    for (let i = 0; i < this.numParticles; i++) indices[i] = i;
    if (this.particleIndexBuffer) gl.deleteBuffer(this.particleIndexBuffer);
    const buf = gl.createBuffer();
    if (buf === null) throw new Error('wind: index buffer alloc failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.particleIndexBuffer = buf;
  }

  /** Re-randomize particle positions (bbox re-anchor / gesture settle). */
  reseed(): void {
    if (this.numParticles > 0) this.setNumParticles(this.numParticles);
  }

  setWind(data: WindGlData): void {
    const gl = this.gl;
    // A new field for the same bbox (TIME scrub) keeps particle positions;
    // the caller reseeds explicitly when the bbox itself moved.
    if (this.windTexture) gl.deleteTexture(this.windTexture);
    this.windTexture = createTexture(gl, gl.LINEAR, data.rgba, data.width, data.height);
    this.windData = data;
  }

  get hasWind(): boolean {
    return this.windData !== null && this.particleStateTexture0 !== null;
  }

  /**
   * Render one frame: trail fade + particles into the screen texture, then
   * composite onto the (transparent) drawing buffer at `globalOpacity`, then
   * one advection step. `matrix` maps field-relative mercator → clip.
   */
  draw(
    matrix: Float32Array,
    globalOpacity: number,
    spawn: GridRect,
    uvPerMps: { x: number; y: number },
  ): void {
    const gl = this.gl;
    if (!this.hasWind) {
      gl.viewport(0, 0, this.viewWidth, this.viewHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    bindTexture(gl, this.windTexture as WebGLTexture, 0);
    bindTexture(gl, this.particleStateTexture0 as WebGLTexture, 1);
    this.drawScreen(matrix, globalOpacity);
    this.updateParticles(spawn, uvPerMps);
  }

  private drawScreen(matrix: Float32Array, globalOpacity: number): void {
    const gl = this.gl;
    bindFramebuffer(gl, this.framebuffer, this.screenTexture as WebGLTexture);
    gl.viewport(0, 0, this.screenWidth, this.screenHeight);
    this.drawTexture(this.backgroundTexture as WebGLTexture, FADE_OPACITY);
    // Heads composite OVER the faded trail (premultiplied) rather than
    // punching a hole in it.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawParticles(matrix);
    gl.disable(gl.BLEND);
    bindFramebuffer(gl, null);
    // Composite over the transparent GLView. The trail buffer is
    // PREMULTIPLIED (see DRAW_FRAG), so the blend must be ONE /
    // ONE_MINUS_SRC_ALPHA — a straight-alpha blend would multiply the colour
    // by alpha a second time and paint faded trails as dark smears.
    gl.viewport(0, 0, this.viewWidth, this.viewHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawTexture(this.screenTexture as WebGLTexture, globalOpacity);
    gl.disable(gl.BLEND);
    const temp = this.backgroundTexture;
    this.backgroundTexture = this.screenTexture;
    this.screenTexture = temp;
  }

  private drawTexture(texture: WebGLTexture, opacity: number): void {
    const gl = this.gl;
    const p = this.screenProgram;
    gl.useProgram(p.program);
    bindAttribute(gl, this.quadBuffer, p.attrib.a_pos ?? 0, 2);
    bindTexture(gl, texture, 2);
    gl.uniform1i(p.uniform.u_screen ?? null, 2);
    gl.uniform1f(p.uniform.u_opacity ?? null, opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawParticles(matrix: Float32Array): void {
    const gl = this.gl;
    const data = this.windData as WindGlData;
    const p = this.drawProgram;
    gl.useProgram(p.program);
    bindAttribute(gl, this.particleIndexBuffer as WebGLBuffer, p.attrib.a_index ?? 0, 1);
    gl.uniform1i(p.uniform.u_wind ?? null, 0);
    gl.uniform1i(p.uniform.u_particles ?? null, 1);
    gl.uniform1f(p.uniform.u_particles_res ?? null, this.particleStateResolution);
    gl.uniform2f(p.uniform.u_wind_min ?? null, data.uMin, data.vMin);
    gl.uniform2f(p.uniform.u_wind_max ?? null, data.uMax, data.vMax);
    gl.uniformMatrix4fv(p.uniform.u_matrix ?? null, false, matrix);
    gl.uniform1f(p.uniform.u_lat_north ?? null, data.latNorth);
    gl.uniform1f(p.uniform.u_lat_span ?? null, data.latSpanDeg);
    gl.uniform1f(p.uniform.u_lon_span ?? null, data.lonSpanDeg);
    gl.uniform1f(p.uniform.u_point_size ?? null, POINT_SIZE * this.pointScale * this.scale);
    gl.drawArrays(gl.POINTS, 0, this.numParticles);
  }

  private updateParticles(spawn: GridRect, uvPerMps: { x: number; y: number }): void {
    const gl = this.gl;
    const data = this.windData as WindGlData;
    bindFramebuffer(gl, this.framebuffer, this.particleStateTexture1 as WebGLTexture);
    gl.viewport(0, 0, this.particleStateResolution, this.particleStateResolution);
    const p = this.updateProgram;
    gl.useProgram(p.program);
    bindAttribute(gl, this.quadBuffer, p.attrib.a_pos ?? 0, 2);
    gl.uniform1i(p.uniform.u_wind ?? null, 0);
    gl.uniform1i(p.uniform.u_particles ?? null, 1);
    gl.uniform1f(p.uniform.u_rand_seed ?? null, Math.random());
    gl.uniform2f(p.uniform.u_wind_res ?? null, data.width, data.height);
    gl.uniform2f(p.uniform.u_wind_min ?? null, data.uMin, data.vMin);
    gl.uniform2f(p.uniform.u_wind_max ?? null, data.uMax, data.vMax);
    // m/s → grid-UV per frame, computed against the VIEWPORT (see
    // advectionUvPerMps) so streak speed reads the same at every zoom.
    gl.uniform2f(p.uniform.u_uv_per_mps ?? null, uvPerMps.x, uvPerMps.y);
    gl.uniform1f(p.uniform.u_drop_rate ?? null, DROP_RATE);
    gl.uniform1f(p.uniform.u_drop_rate_bump ?? null, DROP_RATE_BUMP);
    gl.uniform1f(p.uniform.u_lat_north ?? null, data.latNorth);
    gl.uniform1f(p.uniform.u_lat_span ?? null, data.latSpanDeg);
    gl.uniform1f(p.uniform.u_gust_scale ?? null, GUST_SCALE);
    gl.uniform2f(p.uniform.u_spawn_min ?? null, spawn.minU, spawn.minV);
    gl.uniform2f(p.uniform.u_spawn_max ?? null, spawn.maxU, spawn.maxV);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    bindFramebuffer(gl, null);
    const temp = this.particleStateTexture0;
    this.particleStateTexture0 = this.particleStateTexture1;
    this.particleStateTexture1 = temp;
  }

  /** Free every GL resource (GLView unmount / context replacement). */
  dispose(): void {
    const gl = this.gl;
    for (const t of [
      this.windTexture,
      this.backgroundTexture,
      this.screenTexture,
      this.particleStateTexture0,
      this.particleStateTexture1,
    ]) {
      if (t) gl.deleteTexture(t);
    }
    if (this.particleIndexBuffer) gl.deleteBuffer(this.particleIndexBuffer);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteFramebuffer(this.framebuffer);
    for (const p of [this.drawProgram, this.screenProgram, this.updateProgram]) {
      gl.deleteProgram(p.program);
    }
  }
}
