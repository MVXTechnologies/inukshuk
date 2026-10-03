// Android: the MapLibre custom layer host (GLES 3) and its JNI bridge.
//
// A true 3D scene (owner, #551 redesign — no draping): this layer sits on top
// of the style and, past the pitch ramp, draws its own world over the 2D map,
// crossfading in with the ramp: a sky, the terrain as a shaded relief model in
// the theme's palette (or satellite imagery tiles), contour lines evaluated
// per fragment from the surface height (constant screen width, anti-aliased),
// the user's trails lifted onto the surface, 3D pin labels and the location
// marker. Below the ramp `render()` returns at once: the 2D map is untouched.
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <android/log.h>
#include <jni.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#include "../mln_abi.hpp"
#include "../terrain_engine.hpp"

#define LOG_TAG "InukshukTerrain"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

using namespace inukshuk::terrain;

namespace {

constexpr double kRad2Deg = 180.0 / 3.14159265358979323846;

int64_t nowNs() {
  using namespace std::chrono;
  return duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count();
}

// ---- shaders -----------------------------------------------------------------

const char* kTerrainVs = R"(#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec3 a_grid;   // u, v, skirt
// Every visible tile in ONE instanced draw: per-tile heights in an RGBA32F
// atlas row (hFrom, hTo, slopeX, slopeY per vertex), per-tile data in a block.
uniform sampler2D u_atlas;
layout(std140) uniform Tiles {
  mat4 u_m[128];
  vec4 u_p[128];   // morph, fromFlat, skirt depth * ramp, slot (-1 flat)
  vec4 u_ia[128];  // imagery A: layer, offX, offY, scale
  vec4 u_ib[128];  // imagery B: layer, offX, offY, scale
  vec4 u_ix[128];  // x: blend A→B
};
uniform float u_hRef;
uniform float u_scale;     // exaggeration * ramp
uniform float u_far;
out vec3 v_uvs;            // tile u, v, slot
out float v_h;             // absolute height (m) — contours
out float v_dist;
flat out vec4 v_ia;
flat out vec4 v_ib;
flat out float v_blend;
void main() {
  mat4 m = u_m[gl_InstanceID];
  vec4 p = u_p[gl_InstanceID];
  vec4 a = p.w < 0.0 ? vec4(0.0) : texelFetch(u_atlas, ivec2(gl_VertexID, int(p.w)), 0);
  float to = a.y - u_hRef;
  float from = p.y > 0.5 ? 0.0 : a.x - u_hRef;
  float dh = mix(to, from, p.x);
  float z = dh * u_scale - a_grid.z * p.z;
  vec4 pos = m * vec4(a_grid.xy, z, 1.0);
  v_uvs = vec3(a_grid.xy, p.w);
  v_h = p.w < 0.0 ? u_hRef : u_hRef + dh;
  v_dist = pos.w;
  v_ia = u_ia[gl_InstanceID];
  v_ib = u_ib[gl_InstanceID];
  v_blend = u_ix[gl_InstanceID].x;
  // Our own linear depth: MapLibre's far plane would clip mountains.
  pos.z = (2.0 * pos.w / u_far - 1.0) * pos.w;
  gl_Position = pos;
}
)";

const char* kTerrainFs = R"(#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_detail;   // 64² per slot: slopeX, slopeY, water, glacier
uniform sampler2DArray u_imagery;  // 256² per slot
uniform vec3 u_light;
uniform float u_exag;
uniform vec3 u_fogColor;
uniform vec3 u_fogParams;          // start, density, end (in ctc)
uniform float u_ctc;
uniform float u_ramp;
uniform float u_density;           // physical px per logical px
uniform vec3 u_land, u_rock, u_water, u_glacier, u_shadow, u_highlight;
uniform vec3 u_contour, u_contourMajor;
uniform float u_contourOpacity;
uniform float u_imageryMode;
uniform float u_form;
uniform int u_contourBase;
in vec3 v_uvs;
in float v_h;
in float v_dist;
flat in vec4 v_ia;
flat in vec4 v_ib;
flat in float v_blend;
out vec4 fragColor;

const float LADDER_MINOR[7] = float[7](10.0, 20.0, 25.0, 50.0, 100.0, 200.0, 500.0);
const float LADDER_MAJOR[7] = float[7](50.0, 100.0, 100.0, 250.0, 500.0, 1000.0, 2500.0);
const float MIN_SPACING = 8.0;

float distPx(float h, float interval, float d) {
  float v = h / interval;
  return abs(v - floor(v + 0.5)) * interval / d;
}
float cov(float dist, float width) { return clamp(width * 0.5 + 0.5 - dist, 0.0, 1.0); }
vec2 levelCov(float h, float d, int i) {
  float mi = LADDER_MINOR[i];
  float ma = LADDER_MAJOR[i];
  float maj = cov(distPx(h, ma, d), 2.0);
  float k = floor(h / mi + 0.5);
  float every = floor(ma / mi + 0.5);
  bool isMajor = mod(k, every) == 0.0;
  float mnr = isMajor ? 0.0 : cov(distPx(h, mi, d), 1.1);
  return vec2(mnr, maj);
}

void main() {
  vec4 det = v_uvs.z < 0.0 ? vec4(0.5, 0.5, 0.0, 0.0)
                           : texture(u_detail, vec3(v_uvs.xy, v_uvs.z));
  vec2 slope = (det.rg * 2.0 - 1.0) * 4.0;
  vec3 n = normalize(vec3(-slope * u_exag, 1.0));
  float lambert = max(dot(n, u_light), 0.0);
  float flatL = u_light.z;
  vec3 c;
  if (u_imageryMode > 0.5) {
    vec3 b = v_ib.x < 0.0 ? u_fogColor
                          : texture(u_imagery, vec3(v_ib.yz + v_uvs.xy * v_ib.w, v_ib.x)).rgb;
    vec3 a = v_ia.x < 0.0 ? b : texture(u_imagery, vec3(v_ia.yz + v_uvs.xy * v_ia.w, v_ia.x)).rgb;
    c = mix(a, b, v_blend);
    c *= 1.0 + (lambert - flatL) * u_form;
  } else {
    // shadeSurface (src/core/terrain3d/surface.ts)
    float rock = smoothstep(2200.0, 3400.0, v_h) * 0.35;
    c = mix(u_land, u_rock, rock);
    c = mix(c, u_glacier, det.a);
    float water = max(det.b, v_h <= 0.5 ? 1.0 : 0.0);
    c = mix(c, u_water, water);
    float away = clamp((flatL - lambert) / max(flatL, 1e-6), 0.0, 1.0);
    float lit = clamp((lambert - 0.72) / 0.28, 0.0, 1.0);
    float grad = length(slope) * u_exag;
    float steep = smoothstep(0.4, 1.6, grad) * 0.18 * (1.0 - lit);
    c = mix(c, u_shadow, (1.0 - water) * clamp(away * 0.62 + steep, 0.0, 1.0));
    c = mix(c, u_highlight, (1.0 - water) * lit * 0.45);
  }
  // Contours as geometry: distance to the nearest level in screen px.
  if (u_contourOpacity > 0.0) {
    float d = max(length(vec2(dFdx(v_h), dFdy(v_h))) * u_density, 1e-4);  // m per logical px
    int idx = 6;
    float finer = 0.0;
    for (int i = 0; i < 7; i++) {
      if (i < u_contourBase) continue;
      if (LADDER_MINOR[i] / d >= MIN_SPACING) {
        idx = i;
        if (i > u_contourBase) finer = clamp((LADDER_MINOR[i - 1] / d - (MIN_SPACING - 2.0)) / 2.0, 0.0, 1.0);
        break;
      }
    }
    // Widths are logical px; the distances are in logical px too.
    vec2 cc = levelCov(v_h, d, idx);
    if (finer > 0.0) cc = max(cc, levelCov(v_h, d, idx - 1) * finer);
    float fade = 1.0 - smoothstep(0.55, 0.85, v_dist / (u_ctc * u_fogParams.z));
    c = mix(c, u_contour, cc.x * u_contourOpacity * 0.75 * fade);  // minors a shade lighter
    c = mix(c, u_contourMajor, cc.y * u_contourOpacity * fade);
  }
  // Fog / atmospheric perspective.
  float dc = v_dist / u_ctc;
  float f = dc > u_fogParams.x ? 1.0 - exp(-u_fogParams.y * (dc - u_fogParams.x)) : 0.0;
  float t = clamp((dc - u_fogParams.z * 0.85) / (u_fogParams.z * 0.15), 0.0, 1.0);
  f = max(f, t * t * (3.0 - 2.0 * t));
  c = mix(c, u_fogColor, clamp(f, 0.0, 1.0));
  fragColor = vec4(c, u_ramp);
}
)";

const char* kSkyVs = R"(#version 300 es
precision highp float;
uniform vec4 u_rays[3];
out vec4 v_ray;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  v_ray = u_rays[gl_VertexID];
  gl_Position = vec4(p, 0.0, 1.0);
}
)";

const char* kSkyFs = R"(#version 300 es
precision highp float;
uniform vec3 u_horizon;
uniform vec3 u_zenith;
uniform vec3 u_fogColor;
uniform float u_ramp;
in vec4 v_ray;
out vec4 fragColor;
void main() {
  vec3 d = v_ray.xyz / v_ray.w;
  float e = d.z / max(length(d), 1e-6);
  vec3 sky = mix(u_horizon, u_zenith, smoothstep(0.0, 0.45, e));
  vec3 c = mix(u_fogColor, sky, smoothstep(-0.03, 0.01, e));
  fragColor = vec4(c, u_ramp);
}
)";

// Trails: segment quads extruded to a constant screen width, lifted onto the terrain.
const char* kLineVs = R"(#version 300 es
precision highp float;
layout(location = 0) in vec3 a_a;
layout(location = 1) in vec3 a_b;
layout(location = 2) in vec2 a_se;  // side, end
uniform mat4 u_m;
uniform float u_hRef;
uniform float u_scale;
uniform float u_far;
uniform float u_width;   // logical px
uniform vec2 u_view;     // logical px
void main() {
  vec4 ca = u_m * vec4(a_a.xy, (a_a.z - u_hRef) * u_scale + 2.0, 1.0);
  vec4 cb = u_m * vec4(a_b.xy, (a_b.z - u_hRef) * u_scale + 2.0, 1.0);
  vec4 c = a_se.y > 0.5 ? cb : ca;
  vec2 na = ca.xy / max(ca.w, 1e-6);
  vec2 nb = cb.xy / max(cb.w, 1e-6);
  vec2 dir = (nb - na) * u_view;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // Half width across, and a half-width cap along the segment to close joins.
  vec2 off = (nrm * a_se.x + dir * (a_se.y > 0.5 ? 1.0 : -1.0)) * (u_width * 0.5);
  c.xy += off / u_view * 2.0 * c.w;
  // Slightly in front of the surface it lies on.
  float w = c.w * 0.996;
  c.z = (2.0 * w / u_far - 1.0) * c.w;
  gl_Position = c;
}
)";

const char* kSolidFs = R"(#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }
)";

// Screen-space sprites (label plates, stems, ground dots, the location marker).
const char* kSpriteVs = R"(#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // logical px, origin top-left
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;
layout(location = 3) in float a_mode; // 0 textured, 1 solid, 2 disc, 3 location marker
uniform vec2 u_view;
out vec2 v_uv;
out vec4 v_color;
out float v_mode;
void main() {
  v_uv = a_uv;
  v_color = a_color;
  v_mode = a_mode;
  gl_Position = vec4(a_pos.x / u_view.x * 2.0 - 1.0, 1.0 - a_pos.y / u_view.y * 2.0, 0.0, 1.0);
}
)";

const char* kSpriteFs = R"(#version 300 es
precision mediump float;
uniform sampler2D u_sprites;
in vec2 v_uv;
in vec4 v_color;
in float v_mode;
out vec4 fragColor;
void main() {
  if (v_mode < 0.5) {
    vec4 t = texture(u_sprites, v_uv);  // premultiplied
    fragColor = t * v_color.a;
  } else if (v_mode < 1.5) {
    fragColor = vec4(v_color.rgb * v_color.a, v_color.a);
  } else {
    vec2 q = v_uv * 2.0 - 1.0;
    float r = length(q);
    float aa = fwidth(r);
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0, r);
    vec3 col = v_color.rgb;
    if (v_mode > 2.5) {
      // location marker: blue core, white ring
      col = mix(v_color.rgb, vec3(1.0), smoothstep(0.62 - aa, 0.62, r));
    }
    float a = disc * v_color.a;
    fragColor = vec4(col * a, a);
  }
}
)";

GLuint compile(GLenum type, const char* src) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, nullptr);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[2048];
    glGetShaderInfoLog(s, sizeof log, nullptr, log);
    LOGE("shader compile failed: %s", log);
    glDeleteShader(s);
    return 0;
  }
  return s;
}

GLuint link(const char* vs, const char* fs) {
  GLuint v = compile(GL_VERTEX_SHADER, vs), f = compile(GL_FRAGMENT_SHADER, fs);
  if (!v || !f) return 0;
  GLuint p = glCreateProgram();
  glAttachShader(p, v);
  glAttachShader(p, f);
  glLinkProgram(p);
  glDeleteShader(v);
  glDeleteShader(f);
  GLint ok = 0;
  glGetProgramiv(p, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[2048];
    glGetProgramInfoLog(p, sizeof log, nullptr, log);
    LOGE("program link failed: %s", log);
    glDeleteProgram(p);
    return 0;
  }
  return p;
}

// ---- GL renderer ---------------------------------------------------------------

constexpr int kAtlasWidth = 1224;  // >= vertexCount(kGrid) = 1221
constexpr int kAtlasSlots = 512;
constexpr int kBatch = 128;        // instances per draw (std140 block ≤ 16 KB)
constexpr int kInstanceFloats = 16 + 4 * 4;
constexpr GLuint kTilesBinding = 20;
constexpr int kSpriteAtlas = 2048;

struct TileSlot {
  int slot = -1;
  uint32_t version = 0;
  uint64_t lastFrame = 0;
};

struct LineBuffer {
  GLuint vbo = 0;
  uint32_t version = 0;
  GLsizei count = 0;
  uint64_t lastFrame = 0;
};

struct SpriteUpload {
  int x = 0, y = 0, w = 0, h = 0;
  std::vector<uint8_t> rgba;
};

struct GlRenderer {
  EGLContext context = EGL_NO_CONTEXT;
  bool ready = false;
  GLuint terrainProgram = 0, skyProgram = 0, lineProgram = 0, spriteProgram = 0;
  GLuint vao = 0, skyVao = 0, spriteVao = 0;
  GLuint gridVbo = 0, ibo = 0, atlasTex = 0, detailTex = 0, imageryTex = 0, tilesUbo = 0;
  GLuint spriteTex = 0, spriteVbo = 0;
  GLsizei indexCount = 0;
  std::unordered_map<uint64_t, TileSlot> tiles;
  std::vector<int> freeSlots;
  std::unordered_map<int, LineBuffer> lines;
  std::vector<float> ubo;
  std::vector<float> spriteVerts;
  uint64_t frameNo = 0;
  struct {
    GLint atlas, hRef, scale, far, detail, imagery, light, exag, fogColor, fogParams, ctc, ramp,
        density, land, rock, water, glacier, shadow, highlight, contour, contourMajor,
        contourOpacity, imageryMode, form, contourBase;
  } tu{};
  struct {
    GLint rays, horizon, zenith, fogColor, ramp;
  } su{};
  struct {
    GLint m, hRef, scale, far, width, view, color;
  } lu{};
  struct {
    GLint view, sprites;
  } pu{};

  void init() {
    context = eglGetCurrentContext();
    terrainProgram = link(kTerrainVs, kTerrainFs);
    skyProgram = link(kSkyVs, kSkyFs);
    lineProgram = link(kLineVs, kSolidFs);
    spriteProgram = link(kSpriteVs, kSpriteFs);
    if (!terrainProgram || !skyProgram || !lineProgram || !spriteProgram) return;
#define TU(name) tu.name = glGetUniformLocation(terrainProgram, "u_" #name)
    TU(atlas);
    TU(hRef);
    TU(scale);
    TU(far);
    TU(detail);
    TU(imagery);
    TU(light);
    TU(exag);
    TU(fogColor);
    TU(fogParams);
    TU(ctc);
    TU(ramp);
    TU(density);
    TU(land);
    TU(rock);
    TU(water);
    TU(glacier);
    TU(shadow);
    TU(highlight);
    TU(contour);
    TU(contourMajor);
    TU(contourOpacity);
    TU(imageryMode);
    TU(form);
    TU(contourBase);
#undef TU
    su.rays = glGetUniformLocation(skyProgram, "u_rays");
    su.horizon = glGetUniformLocation(skyProgram, "u_horizon");
    su.zenith = glGetUniformLocation(skyProgram, "u_zenith");
    su.fogColor = glGetUniformLocation(skyProgram, "u_fogColor");
    su.ramp = glGetUniformLocation(skyProgram, "u_ramp");
#define LU(name) lu.name = glGetUniformLocation(lineProgram, "u_" #name)
    LU(m);
    LU(hRef);
    LU(scale);
    LU(far);
    LU(width);
    LU(view);
    LU(color);
#undef LU
    pu.view = glGetUniformLocation(spriteProgram, "u_view");
    pu.sprites = glGetUniformLocation(spriteProgram, "u_sprites");

    const auto verts = buildGridVertices(kGrid);
    const auto idx32 = buildGridIndices(kGrid);
    std::vector<uint16_t> idx(idx32.begin(), idx32.end());
    indexCount = static_cast<GLsizei>(idx.size());
    glGenVertexArrays(1, &vao);
    glGenVertexArrays(1, &skyVao);
    glGenVertexArrays(1, &spriteVao);
    glGenBuffers(1, &gridVbo);
    glGenBuffers(1, &ibo);
    glBindVertexArray(vao);
    glBindBuffer(GL_ARRAY_BUFFER, gridVbo);
    glBufferData(GL_ARRAY_BUFFER, verts.size() * sizeof(float), verts.data(), GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), nullptr);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, idx.size() * sizeof(uint16_t), idx.data(), GL_STATIC_DRAW);
    glBindVertexArray(0);

    glUniformBlockBinding(terrainProgram, glGetUniformBlockIndex(terrainProgram, "Tiles"), kTilesBinding);
    glGenBuffers(1, &tilesUbo);
    glBindBuffer(GL_UNIFORM_BUFFER, tilesUbo);
    glBufferData(GL_UNIFORM_BUFFER, kBatch * kInstanceFloats * sizeof(float), nullptr, GL_DYNAMIC_DRAW);
    glBindBuffer(GL_UNIFORM_BUFFER, 0);

    glGenTextures(1, &atlasTex);
    glBindTexture(GL_TEXTURE_2D, atlasTex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, kAtlasWidth, kAtlasSlots, 0, GL_RGBA, GL_FLOAT, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);

    glGenTextures(1, &detailTex);
    glBindTexture(GL_TEXTURE_2D_ARRAY, detailTex);
    glTexImage3D(GL_TEXTURE_2D_ARRAY, 0, GL_RGBA8, kDetailSize, kDetailSize, kAtlasSlots, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    glGenTextures(1, &spriteTex);
    glBindTexture(GL_TEXTURE_2D, spriteTex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kSpriteAtlas, kSpriteAtlas, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glBindTexture(GL_TEXTURE_2D, 0);

    glGenBuffers(1, &spriteVbo);
    glBindVertexArray(spriteVao);
    glBindBuffer(GL_ARRAY_BUFFER, spriteVbo);
    const GLsizei stride = 9 * sizeof(float);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, stride, nullptr);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(2 * sizeof(float)));
    glEnableVertexAttribArray(2);
    glVertexAttribPointer(2, 4, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(4 * sizeof(float)));
    glEnableVertexAttribArray(3);
    glVertexAttribPointer(3, 1, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(8 * sizeof(float)));
    glBindVertexArray(0);
    glBindBuffer(GL_ARRAY_BUFFER, 0);

    freeSlots.clear();
    for (int i = kAtlasSlots - 1; i >= 0; i--) freeSlots.push_back(i);
    ubo.assign(kBatch * kInstanceFloats, 0.f);
    ready = true;
    LOGI("GL renderer ready");
  }

  void ensureImageryTex() {
    if (imageryTex) return;
    glGenTextures(1, &imageryTex);
    glBindTexture(GL_TEXTURE_2D_ARRAY, imageryTex);
    glTexImage3D(GL_TEXTURE_2D_ARRAY, 0, GL_RGBA8, kImagerySize, kImagerySize, Engine::kImagerySlots,
                 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  }

  void forget() { *this = GlRenderer{}; }

  void destroy() {
    if (eglGetCurrentContext() != context || context == EGL_NO_CONTEXT) {
      forget();
      return;
    }
    for (auto& [k, l] : lines) glDeleteBuffers(1, &l.vbo);
    GLuint progs[] = {terrainProgram, skyProgram, lineProgram, spriteProgram};
    for (GLuint p : progs)
      if (p) glDeleteProgram(p);
    GLuint vaos[] = {vao, skyVao, spriteVao};
    glDeleteVertexArrays(3, vaos);
    GLuint bufs[] = {gridVbo, ibo, tilesUbo, spriteVbo};
    glDeleteBuffers(4, bufs);
    GLuint texs[] = {atlasTex, detailTex, spriteTex, imageryTex};
    glDeleteTextures(4, texs);
    forget();
  }

  /** The tile's atlas slot (heights + detail uploaded if changed), or -1 for a flat tile. */
  int slotFor(const DrawTile& d) {
    if (!d.attributes) return -1;
    auto it = tiles.find(d.key);
    if (it == tiles.end()) {
      if (freeSlots.empty()) evictSlots(true);
      if (freeSlots.empty()) return -1;
      TileSlot t;
      t.slot = freeSlots.back();
      freeSlots.pop_back();
      it = tiles.emplace(d.key, t).first;
    }
    TileSlot& t = it->second;
    if (t.version != d.version) {
      // Upload through the textures' own units (unit 0 is not ours to rebind mid-draw).
      glActiveTexture(GL_TEXTURE1);
      glBindTexture(GL_TEXTURE_2D, atlasTex);
      glTexSubImage2D(GL_TEXTURE_2D, 0, 0, t.slot, vertexCount(kGrid), 1, GL_RGBA, GL_FLOAT,
                      d.attributes->data());
      if (d.detail) {
        glActiveTexture(GL_TEXTURE2);
        glBindTexture(GL_TEXTURE_2D_ARRAY, detailTex);
        glTexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, 0, 0, t.slot, kDetailSize, kDetailSize, 1, GL_RGBA,
                        GL_UNSIGNED_BYTE, d.detail->data());
      }
      glActiveTexture(GL_TEXTURE0);
      t.version = d.version;
    }
    t.lastFrame = frameNo;
    return t.slot;
  }

  void evictSlots(bool force) {
    if (!force && freeSlots.size() > 64) return;
    for (auto it = tiles.begin(); it != tiles.end();) {
      if (frameNo - it->second.lastFrame > (force ? 0u : 120u)) {
        freeSlots.push_back(it->second.slot);
        it = tiles.erase(it);
      } else {
        ++it;
      }
    }
  }

  void uploadSprites(std::vector<SpriteUpload>& ups) {
    if (ups.empty()) return;
    glActiveTexture(GL_TEXTURE3);
    glBindTexture(GL_TEXTURE_2D, spriteTex);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    for (auto& u : ups)
      glTexSubImage2D(GL_TEXTURE_2D, 0, u.x, u.y, u.w, u.h, GL_RGBA, GL_UNSIGNED_BYTE, u.rgba.data());
    glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
    glActiveTexture(GL_TEXTURE0);
    ups.clear();
  }

  void quad(float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1,
            const float* col, float mode) {
    const float v[6][4] = {{x0, y0, u0, v0}, {x1, y0, u1, v0}, {x1, y1, u1, v1},
                           {x0, y0, u0, v0}, {x1, y1, u1, v1}, {x0, y1, u0, v1}};
    for (const auto& p : v)
      spriteVerts.insert(spriteVerts.end(), {p[0], p[1], p[2], p[3], col[0], col[1], col[2], col[3], mode});
  }

  void draw(const FrameOutput& out, const float* ink) {
    frameNo++;
    GLint vp[4];
    glGetIntegerv(GL_VIEWPORT, vp);
    if (vp[2] <= 0 || vp[3] <= 0 || out.width <= 0) return;
    const float density = static_cast<float>(vp[2]) / out.width;
    const int dbg = out.look.debugFlags;
    const float ramp = out.ramp;
    const bool imageryMode = out.look.imagery > 0.5f;

    glDisable(GL_STENCIL_TEST);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_CULL_FACE);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glEnable(GL_BLEND);
    glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ZERO, GL_ONE);

    // 1. Sky (and haze below the horizon), crossfading in with the ramp.
    glDisable(GL_DEPTH_TEST);
    glDepthMask(GL_FALSE);
    if (!(dbg & 4) && out.skyVisible) {
      glUseProgram(skyProgram);
      glUniform4fv(su.rays, 3, &out.skyRays[0][0]);
      glUniform3fv(su.horizon, 1, out.look.skyHorizon);
      glUniform3fv(su.zenith, 1, out.look.skyZenith);
      glUniform3fv(su.fogColor, 1, out.look.fogColor);
      glUniform1f(su.ramp, ramp);
      glBindVertexArray(skyVao);
      glDrawArrays(GL_TRIANGLES, 0, 3);
    }

    // 2. Imagery uploads (satellite).
    if (imageryMode && !out.imageryUploads.empty()) {
      ensureImageryTex();
      glActiveTexture(GL_TEXTURE4);
      glBindTexture(GL_TEXTURE_2D_ARRAY, imageryTex);
      for (const auto& u : out.imageryUploads)
        glTexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, 0, 0, u.slot, kImagerySize, kImagerySize, 1, GL_RGBA,
                        GL_UNSIGNED_BYTE, u.pixels->data());
      glActiveTexture(GL_TEXTURE0);
    }

    // 3. Terrain, front to back, our own depth.
    glDepthMask(GL_TRUE);
    glClearDepthf(1.0f);
    glClear(GL_DEPTH_BUFFER_BIT);
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_LESS);
    glDepthRangef(0.0f, 1.0f);
    glUseProgram(terrainProgram);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, atlasTex);
    glActiveTexture(GL_TEXTURE2);
    glBindTexture(GL_TEXTURE_2D_ARRAY, detailTex);
    if (imageryMode) {
      ensureImageryTex();
      glActiveTexture(GL_TEXTURE4);
      glBindTexture(GL_TEXTURE_2D_ARRAY, imageryTex);
    }
    glActiveTexture(GL_TEXTURE0);
    glUniform1i(tu.atlas, 1);
    glUniform1i(tu.detail, 2);
    glUniform1i(tu.imagery, 4);
    glUniform3fv(tu.light, 1, out.light);
    glUniform1f(tu.exag, out.exaggeration);
    glUniform3fv(tu.fogColor, 1, out.look.fogColor);
    glUniform3f(tu.fogParams, out.look.fogStartCtc, out.look.fogDensity, out.look.fogEndCtc);
    glUniform1f(tu.ctc, out.ctc);
    glUniform1f(tu.ramp, ramp);
    glUniform1f(tu.density, density);
    glUniform3fv(tu.land, 1, out.look.land);
    glUniform3fv(tu.rock, 1, out.look.rock);
    glUniform3fv(tu.water, 1, out.look.water);
    glUniform3fv(tu.glacier, 1, out.look.glacier);
    glUniform3fv(tu.shadow, 1, out.look.shadow);
    glUniform3fv(tu.highlight, 1, out.look.highlight);
    glUniform3fv(tu.contour, 1, out.look.contour);
    glUniform3fv(tu.contourMajor, 1, out.look.contourMajor);
    glUniform1f(tu.contourOpacity, out.look.contourOpacity);
    glUniform1f(tu.imageryMode, imageryMode ? 1.f : 0.f);
    glUniform1f(tu.form, out.look.formStrength * 2.0f);
    glUniform1i(tu.contourBase, out.contourBase);
    glUniform1f(tu.hRef, out.hRef);
    glUniform1f(tu.scale, out.exaggeration * ramp);
    glUniform1f(tu.far, out.farW);
    glBindVertexArray(vao);
    glBindBufferBase(GL_UNIFORM_BUFFER, kTilesBinding, tilesUbo);
    const size_t total = (dbg & 2) ? 0 : out.tiles.size();
    for (size_t start = 0; start < total; start += kBatch) {
      const int n = static_cast<int>(std::min<size_t>(kBatch, total - start));
      float* M = ubo.data();
      float* Pp = M + kBatch * 16;
      float* IA = Pp + kBatch * 4;
      float* IB = IA + kBatch * 4;
      float* IX = IB + kBatch * 4;
      for (int i = 0; i < n; i++) {
        const DrawTile& d = out.tiles[start + i];
        const int slot = slotFor(d);
        std::copy(d.matrix, d.matrix + 16, M + i * 16);
        Pp[i * 4] = slot < 0 ? 1.f : d.morph;
        Pp[i * 4 + 1] = slot < 0 ? 1.f : d.fromFlat;
        Pp[i * 4 + 2] = d.skirtDepth * ramp;
        Pp[i * 4 + 3] = static_cast<float>(slot);
        IA[i * 4] = static_cast<float>(d.imgA);
        IA[i * 4 + 1] = d.winA[0];
        IA[i * 4 + 2] = d.winA[1];
        IA[i * 4 + 3] = d.winA[2];
        IB[i * 4] = static_cast<float>(d.imgB);
        IB[i * 4 + 1] = d.winB[0];
        IB[i * 4 + 2] = d.winB[1];
        IB[i * 4 + 3] = d.winB[2];
        IX[i * 4] = d.imgBlend;
      }
      glBindBuffer(GL_UNIFORM_BUFFER, tilesUbo);
      glBufferSubData(GL_UNIFORM_BUFFER, 0, kBatch * kInstanceFloats * sizeof(float), ubo.data());
      glDrawElementsInstanced(GL_TRIANGLES, indexCount, GL_UNSIGNED_SHORT, nullptr, n);
    }
    glBindBuffer(GL_UNIFORM_BUFFER, 0);

    // 4. Trails on the surface: halo then line, depth-tested, no depth writes.
    glDepthMask(GL_FALSE);
    glDepthFunc(GL_LEQUAL);
    glUseProgram(lineProgram);
    glUniform1f(lu.hRef, out.hRef);
    glUniform1f(lu.scale, out.exaggeration * ramp);
    glUniform1f(lu.far, out.farW);
    glUniform2f(lu.view, out.width, out.height);
    glBindVertexArray(0);
    for (const auto& l : out.lines) {
      auto& lb = lines[l.id];
      if (!lb.vbo) glGenBuffers(1, &lb.vbo);
      glBindBuffer(GL_ARRAY_BUFFER, lb.vbo);
      if (lb.version != l.version) {
        glBufferData(GL_ARRAY_BUFFER, l.vertices->size() * sizeof(float), l.vertices->data(), GL_STATIC_DRAW);
        lb.version = l.version;
        lb.count = static_cast<GLsizei>(l.vertices->size() / 8);
      }
      lb.lastFrame = frameNo;
      const GLsizei stride = 8 * sizeof(float);
      glEnableVertexAttribArray(0);
      glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride, nullptr);
      glEnableVertexAttribArray(1);
      glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(3 * sizeof(float)));
      glEnableVertexAttribArray(2);
      glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(6 * sizeof(float)));
      glUniformMatrix4fv(lu.m, 1, GL_FALSE, l.matrix);
      const float halo[4] = {l.style.halo[0], l.style.halo[1], l.style.halo[2], l.style.halo[3] * ramp};
      glUniform4fv(lu.color, 1, halo);
      glUniform1f(lu.width, l.style.haloWidth);
      glDrawArrays(GL_TRIANGLES, 0, lb.count);
      const float col[4] = {l.style.color[0], l.style.color[1], l.style.color[2], l.style.color[3] * ramp};
      glUniform4fv(lu.color, 1, col);
      glUniform1f(lu.width, l.style.width);
      glDrawArrays(GL_TRIANGLES, 0, lb.count);
    }
    for (int a = 0; a < 3; a++) glDisableVertexAttribArray(a);
    for (auto it = lines.begin(); it != lines.end();) {
      if (frameNo - it->second.lastFrame > 60) {
        glDeleteBuffers(1, &it->second.vbo);
        it = lines.erase(it);
      } else {
        ++it;
      }
    }

    // 5. Pins and the location marker: screen-space, over everything (the
    //    engine already hid what the terrain occludes).
    glDisable(GL_DEPTH_TEST);
    glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);  // premultiplied
    spriteVerts.clear();
    for (const auto& l : out.labels) {
      const float a = l.opacity * ramp;
      const float stemCol[4] = {ink[0], ink[1], ink[2], 0.75f * a};
      const float sw = 0.75f;  // half stem width
      quad(l.gx - sw, l.y1, l.gx + sw, l.gy, 0, 0, 0, 0, stemCol, 1);
      const float dotCol[4] = {ink[0], ink[1], ink[2], 0.9f * a};
      const float r = 3.0f * l.scale;
      quad(l.gx - r, l.gy - r, l.gx + r, l.gy + r, 0, 0, 1, 1, dotCol, 2);
      const float plate[4] = {1, 1, 1, a};
      quad(l.x0, l.y0, l.x1, l.y1, l.u0, l.v0, l.u1, l.v1, plate, 0);
    }
    if (out.puck.visible) {
      const float blue[4] = {0.16f, 0.45f, 0.95f, ramp};
      const float halo[4] = {0.16f, 0.45f, 0.95f, 0.18f * ramp};
      quad(out.puck.gx - 22, out.puck.gy - 22, out.puck.gx + 22, out.puck.gy + 22, 0, 0, 1, 1, halo, 2);
      quad(out.puck.gx - 9, out.puck.gy - 9, out.puck.gx + 9, out.puck.gy + 9, 0, 0, 1, 1, blue, 3);
    }
    if (!spriteVerts.empty()) {
      glUseProgram(spriteProgram);
      glUniform2f(pu.view, out.width, out.height);
      glActiveTexture(GL_TEXTURE3);
      glBindTexture(GL_TEXTURE_2D, spriteTex);
      glUniform1i(pu.sprites, 3);
      glActiveTexture(GL_TEXTURE0);
      glBindVertexArray(spriteVao);
      glBindBuffer(GL_ARRAY_BUFFER, spriteVbo);
      glBufferData(GL_ARRAY_BUFFER, spriteVerts.size() * sizeof(float), spriteVerts.data(), GL_STREAM_DRAW);
      glDrawArrays(GL_TRIANGLES, 0, static_cast<GLsizei>(spriteVerts.size() / 9));
    }

    glBindVertexArray(0);
    glBindBuffer(GL_ARRAY_BUFFER, 0);
    glUseProgram(0);
    glDepthMask(GL_TRUE);
    glDisable(GL_DEPTH_TEST);
    evictSlots(false);
  }
};

// ---- the shared state behind one attached map ----------------------------------

struct Wrapper {
  JavaVM* vm = nullptr;
  jobject bridge = nullptr;  // global ref
  jmethodID requestDem = nullptr, requestImagery = nullptr, requestRepaint = nullptr;
  std::unique_ptr<Engine> engine;
  GlRenderer gl;
  std::mutex glMutex;
  std::mutex spriteMutex;
  std::vector<SpriteUpload> spriteUploads;
  float labelInk[3] = {0.18f, 0.16f, 0.13f};
  std::atomic<bool> enabled{true};
  std::atomic<bool> detached{false};
  std::atomic<bool> recording{false};
  std::mutex timesMutex;
  std::vector<int64_t> frameTimes;
  std::vector<int64_t> renderCostNs;
  std::atomic<double> lastPitchDeg{0};
  std::atomic<double> lastDrawMs{0};
  std::atomic<int> drawnTiles{0};

  JNIEnv* env() {
    JNIEnv* e = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&e), JNI_VERSION_1_6) != JNI_OK) {
      vm->AttachCurrentThread(&e, nullptr);
    }
    return e;
  }

  ~Wrapper() {
    if (bridge && vm) {
      JNIEnv* e = env();
      if (e) e->DeleteGlobalRef(bridge);
    }
  }
};

using WrapperPtr = std::shared_ptr<Wrapper>;

class Host final : public mln::style::CustomLayerHost {
 public:
  explicit Host(WrapperPtr w) : w_(std::move(w)) {}

  void initialize(const mln::style::CustomLayerInitParameters&) override {
    std::lock_guard<std::mutex> lock(w_->glMutex);
    if (!w_->gl.ready || w_->gl.context != eglGetCurrentContext()) {
      if (w_->gl.ready) w_->gl.forget();
      w_->gl.init();
    }
  }

  void render(const mln::style::CustomLayerRenderParameters& p) override {
    const int64_t t0 = nowNs();
    if (w_->recording.load()) {
      std::lock_guard<std::mutex> lock(w_->timesMutex);
      w_->frameTimes.push_back(t0);
    }
    const double pitchDeg = p.pitch * kRad2Deg;
    w_->lastPitchDeg = pitchDeg;
    if (!w_->enabled.load() || !w_->gl.ready) return;
    FrameInput in;
    for (int i = 0; i < 16; i++) in.P[i] = p.projectionMatrix[i];
    in.width = p.width;
    in.height = p.height;
    in.fovRad = p.fieldOfView > 0 ? p.fieldOfView : 0.6435011087932844;
    in.zoom = p.zoom;
    in.lat = p.latitude;
    in.lng = p.longitude;
    in.bearingDeg = p.bearing;
    in.pitchDeg = pitchDeg;
    in.timeMs = t0 / 1e6;
    FrameOutput out = w_->engine->frame(in);
    if (!out.active) {
      w_->drawnTiles = 0;
      return;
    }
    {
      std::lock_guard<std::mutex> lock(w_->glMutex);
      float ink[3];
      {
        std::lock_guard<std::mutex> sl(w_->spriteMutex);
        w_->gl.uploadSprites(w_->spriteUploads);
        std::copy(w_->labelInk, w_->labelInk + 3, ink);
      }
      w_->gl.draw(out, ink);
    }
    w_->drawnTiles = static_cast<int>(out.tiles.size());
    const int64_t cost = nowNs() - t0;
    w_->lastDrawMs = cost / 1e6;
    if (w_->recording.load()) {
      std::lock_guard<std::mutex> lock(w_->timesMutex);
      w_->renderCostNs.push_back(cost);
    }
    if (out.needsRepaint) callRepaint();
  }

  void contextLost() override {
    std::lock_guard<std::mutex> lock(w_->glMutex);
    w_->gl.forget();
  }

  void deinitialize() override {
    if (w_->detached.load()) {
      std::lock_guard<std::mutex> lock(w_->glMutex);
      w_->gl.destroy();
    }
  }

 private:
  void callRepaint() {
    JNIEnv* e = w_->env();
    if (e && w_->bridge) e->CallVoidMethod(w_->bridge, w_->requestRepaint);
  }
  WrapperPtr w_;
};

WrapperPtr* handle(jlong h) { return reinterpret_cast<WrapperPtr*>(h); }

std::vector<std::vector<Pt>> ringsFrom(JNIEnv* env, jdoubleArray coords, jintArray counts) {
  std::vector<std::vector<Pt>> rings;
  if (!coords || !counts) return rings;
  const jsize nc = env->GetArrayLength(counts);
  std::vector<jint> cnt(static_cast<size_t>(nc));
  env->GetIntArrayRegion(counts, 0, nc, cnt.data());
  const jsize nd = env->GetArrayLength(coords);
  std::vector<jdouble> xy(static_cast<size_t>(nd));
  env->GetDoubleArrayRegion(coords, 0, nd, xy.data());
  size_t k = 0;
  for (jint c : cnt) {
    std::vector<Pt> r;
    r.reserve(static_cast<size_t>(c));
    for (jint i = 0; i < c && k + 1 < xy.size(); i++, k += 2) r.push_back({xy[k], xy[k + 1]});
    rings.push_back(std::move(r));
  }
  return rings;
}

}  // namespace

// ---- JNI ---------------------------------------------------------------------------

extern "C" {

JNIEXPORT jlong JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeCreate(
    JNIEnv* env, jclass, jobject bridge) {
  auto w = std::make_shared<Wrapper>();
  env->GetJavaVM(&w->vm);
  w->bridge = env->NewGlobalRef(bridge);
  jclass cls = env->GetObjectClass(bridge);
  w->requestDem = env->GetMethodID(cls, "requestDem", "(III)V");
  w->requestImagery = env->GetMethodID(cls, "requestImagery", "(III)V");
  w->requestRepaint = env->GetMethodID(cls, "requestRepaint", "()V");
  Wrapper* raw = w.get();
  w->engine = std::make_unique<Engine>(
      [raw](int z, int x, int y) {
        JNIEnv* e = raw->env();
        if (e && raw->bridge) e->CallVoidMethod(raw->bridge, raw->requestDem, z, x, y);
      },
      [raw](int z, int x, int y) {
        JNIEnv* e = raw->env();
        if (e && raw->bridge) e->CallVoidMethod(raw->bridge, raw->requestImagery, z, x, y);
      },
      [raw] {
        JNIEnv* e = raw->env();
        if (e && raw->bridge) e->CallVoidMethod(raw->bridge, raw->requestRepaint);
      });
  return reinterpret_cast<jlong>(new WrapperPtr(std::move(w)));
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeDestroy(JNIEnv*, jclass,
                                                                                    jlong h) {
  auto* p = handle(h);
  (*p)->detached = true;
  (*p)->enabled = false;
  delete p;
}

JNIEXPORT jlong JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeCreateHost(JNIEnv*, jclass,
                                                                                        jlong h) {
  return reinterpret_cast<jlong>(static_cast<mln::style::CustomLayerHost*>(new Host(*handle(h))));
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeSetEnabled(
    JNIEnv*, jclass, jlong h, jboolean enabled) {
  (*handle(h))->enabled = enabled == JNI_TRUE;
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeSetLook(
    JNIEnv* env, jclass, jlong h, jfloatArray values) {
  const jsize n = env->GetArrayLength(values);
  if (n < 40) return;
  std::vector<jfloat> v(static_cast<size_t>(n));
  env->GetFloatArrayRegion(values, 0, n, v.data());
  (*handle(h))->engine->setLook(lookFromFloats(v.data(), n));
}

JNIEXPORT jboolean JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeOnDemData(
    JNIEnv* env, jclass, jlong h, jint z, jint x, jint y, jbyteArray bytes) {
  const jsize n = env->GetArrayLength(bytes);
  std::vector<uint8_t> buf(static_cast<size_t>(n));
  env->GetByteArrayRegion(bytes, 0, n, reinterpret_cast<jbyte*>(buf.data()));
  return (*handle(h))->engine->onDemData(z, x, y, buf.data(), buf.size()) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeOnDemFailed(
    JNIEnv*, jclass, jlong h, jint z, jint x, jint y) {
  (*handle(h))->engine->onDemFailed(z, x, y);
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeOnImageryData(
    JNIEnv* env, jclass, jlong h, jint z, jint x, jint y, jbyteArray rgba) {
  if (!rgba) {
    (*handle(h))->engine->onImageryFailed(z, x, y);
    return;
  }
  const jsize n = env->GetArrayLength(rgba);
  std::vector<uint8_t> buf(static_cast<size_t>(n));
  env->GetByteArrayRegion(rgba, 0, n, reinterpret_cast<jbyte*>(buf.data()));
  (*handle(h))->engine->onImageryData(z, x, y, std::move(buf));
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeSetLabels(
    JNIEnv* env, jclass, jlong h, jdoubleArray values, jfloatArray ink) {
  // [id, mercX, mercY, kind, priority, w, h, u0, v0, u1, v1] per label
  if (ink && env->GetArrayLength(ink) >= 3) {
    auto& wr = *handle(h);
    std::lock_guard<std::mutex> lock(wr->spriteMutex);
    env->GetFloatArrayRegion(ink, 0, 3, wr->labelInk);
  }
  const jsize n = env->GetArrayLength(values);
  std::vector<jdouble> v(static_cast<size_t>(n));
  env->GetDoubleArrayRegion(values, 0, n, v.data());
  std::vector<LabelData> labels;
  for (jsize i = 0; i + 10 < n; i += 11) {
    LabelData d;
    d.id = static_cast<int>(v[i]);
    d.mercX = v[i + 1];
    d.mercY = v[i + 2];
    d.kind = static_cast<int>(v[i + 3]);
    d.priority = v[i + 4];
    d.w = static_cast<float>(v[i + 5]);
    d.h = static_cast<float>(v[i + 6]);
    d.u0 = static_cast<float>(v[i + 7]);
    d.v0 = static_cast<float>(v[i + 8]);
    d.u1 = static_cast<float>(v[i + 9]);
    d.v1 = static_cast<float>(v[i + 10]);
    labels.push_back(d);
  }
  (*handle(h))->engine->setLabels(std::move(labels));
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeUploadSprite(
    JNIEnv* env, jclass, jlong h, jint x, jint y, jint w, jint hh, jbyteArray rgba) {
  SpriteUpload u;
  u.x = x;
  u.y = y;
  u.w = w;
  u.h = hh;
  const jsize n = env->GetArrayLength(rgba);
  u.rgba.resize(static_cast<size_t>(n));
  env->GetByteArrayRegion(rgba, 0, n, reinterpret_cast<jbyte*>(u.rgba.data()));
  auto& wr = *handle(h);
  std::lock_guard<std::mutex> lock(wr->spriteMutex);
  wr->spriteUploads.push_back(std::move(u));
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeSetPolyline(
    JNIEnv* env, jclass, jlong h, jint id, jdoubleArray merc, jfloatArray style) {
  const jsize n = env->GetArrayLength(merc);
  std::vector<jdouble> v(static_cast<size_t>(n));
  env->GetDoubleArrayRegion(merc, 0, n, v.data());
  std::vector<Pt> pts;
  for (jsize i = 0; i + 1 < n; i += 2) pts.push_back({v[i], v[i + 1]});
  LineStyle ls;
  if (env->GetArrayLength(style) >= 11) {
    jfloat s[11];
    env->GetFloatArrayRegion(style, 0, 11, s);
    for (int i = 0; i < 4; i++) {
      ls.color[i] = s[i];
      ls.halo[i] = s[4 + i];
    }
    ls.width = s[8];
    ls.haloWidth = s[9];
    ls.order = static_cast<int>(s[10]);
  }
  (*handle(h))->engine->setPolyline(id, std::move(pts), ls);
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeRemovePolyline(
    JNIEnv*, jclass, jlong h, jint id) {
  (*handle(h))->engine->removePolyline(id);
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeSetPuck(
    JNIEnv*, jclass, jlong h, jboolean visible, jdouble mx, jdouble my) {
  (*handle(h))->engine->setPuck(visible == JNI_TRUE, mx, my);
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeSetMasks(
    JNIEnv* env, jclass, jlong h, jdoubleArray waterXY, jintArray waterCounts, jdoubleArray iceXY,
    jintArray iceCounts) {
  (*handle(h))->engine->setMasks(ringsFrom(env, waterXY, waterCounts), ringsFrom(env, iceXY, iceCounts));
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeTrimMemory(JNIEnv*, jclass,
                                                                                       jlong h) {
  (*handle(h))->engine->trimMemory();
}

JNIEXPORT void JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeSetRecording(
    JNIEnv*, jclass, jlong h, jboolean on) {
  auto& w = *handle(h);
  std::lock_guard<std::mutex> lock(w->timesMutex);
  if (on) {
    w->frameTimes.clear();
    w->renderCostNs.clear();
  }
  w->recording = on == JNI_TRUE;
}

JNIEXPORT jlongArray JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeTakeFrameTimes(
    JNIEnv* env, jclass, jlong h, jboolean costs) {
  auto& w = *handle(h);
  std::vector<int64_t> v;
  {
    std::lock_guard<std::mutex> lock(w->timesMutex);
    v = costs ? w->renderCostNs : w->frameTimes;
  }
  jlongArray arr = env->NewLongArray(static_cast<jsize>(v.size()));
  env->SetLongArrayRegion(arr, 0, static_cast<jsize>(v.size()), reinterpret_cast<const jlong*>(v.data()));
  return arr;
}

JNIEXPORT jdoubleArray JNICALL Java_expo_modules_inukshukterrain_TerrainNative_nativeStats(JNIEnv* env,
                                                                                          jclass,
                                                                                          jlong h) {
  auto& w = *handle(h);
  const EngineStats s = w->engine->stats();
  const double v[] = {static_cast<double>(s.demCount),
                      static_cast<double>(s.demBytes),
                      static_cast<double>(s.meshCount),
                      static_cast<double>(w->drawnTiles.load()),
                      static_cast<double>(s.flatTiles),
                      static_cast<double>(s.inFlight),
                      static_cast<double>(s.requested),
                      static_cast<double>(s.failed),
                      s.lastFrameCpuMs,
                      w->lastDrawMs.load(),
                      w->lastPitchDeg.load(),
                      static_cast<double>(w->gl.tiles.size()),
                      static_cast<double>(s.labelsShown),
                      static_cast<double>(s.imagerySlots),
                      static_cast<double>(s.bakeQueue)};
  const jsize n = sizeof(v) / sizeof(v[0]);
  jdoubleArray arr = env->NewDoubleArray(n);
  env->SetDoubleArrayRegion(arr, 0, n, v);
  return arr;
}

}  // extern "C"
