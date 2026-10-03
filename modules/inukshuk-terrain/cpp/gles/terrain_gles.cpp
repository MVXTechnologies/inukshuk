// Android: the MapLibre custom layer host (GLES 3) and its JNI bridge.
//
// Frame drape (docs/plans/native-terrain.md): this layer sits on top of the
// style. When the map is tilted past the ramp it copies the frame MapLibre
// just drew (every layer below it) into a texture, clears depth, draws a sky,
// then the terrain mesh, each vertex sampling the copy at its own FLAT screen
// position — so the 3D surface shows exactly the 2D map, and at ramp 0 it is
// the 2D map, pixel for pixel. Below the ramp `render()` returns at once.
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
// Every visible tile in ONE instanced draw: per-tile heights live in an
// RGBA32F atlas (one row per tile slot: hFrom, hTo, slopeX, slopeY per
// vertex), per-tile matrix and params in a uniform block.
uniform sampler2D u_atlas;
layout(std140) uniform Tiles {
  mat4 u_m[192];
  vec4 u_p[192];  // morph, fromFlat, skirt depth * ramp, atlas slot (-1 = flat)
};
uniform float u_hRef;
uniform float u_scale;     // exaggeration * ramp
uniform float u_far;
out vec3 v_flat;
out vec2 v_slope;
out float v_dist;
void main() {
  mat4 m = u_m[gl_InstanceID];
  vec4 p = u_p[gl_InstanceID];
  vec4 a = p.w < 0.0 ? vec4(0.0) : texelFetch(u_atlas, ivec2(gl_VertexID, int(p.w)), 0);
  float to = a.y - u_hRef;
  float from = p.y > 0.5 ? 0.0 : a.x - u_hRef;
  float dh = mix(to, from, p.x);
  float z = dh * u_scale - a_grid.z * p.z;
  vec4 flatPos = m * vec4(a_grid.xy, 0.0, 1.0);
  vec4 pos = m * vec4(a_grid.xy, z, 1.0);
  v_flat = flatPos.xyw;
  v_slope = a.zw;
  v_dist = pos.w;
  // Our own linear depth: MapLibre's far plane would clip mountains.
  pos.z = (2.0 * pos.w / u_far - 1.0) * pos.w;
  gl_Position = pos;
}
)";

const char* kTerrainFs = R"(#version 300 es
precision highp float;
uniform sampler2D u_drape;
uniform vec3 u_light;
uniform float u_form;      // strength * 2 * ramp
uniform float u_exag;
uniform vec3 u_fogColor;
uniform vec3 u_fogParams;  // start, density, end (in ctc)
uniform float u_ctc;
uniform float u_ramp;
in vec3 v_flat;
in vec2 v_slope;
in float v_dist;
out vec4 fragColor;
void main() {
  vec2 uv = v_flat.xy / v_flat.z * 0.5 + 0.5;
  float topOut = max(uv.y - 1.0, 0.0);
  vec3 c = texture(u_drape, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  vec3 n = normalize(vec3(-v_slope * u_exag, 1.0));
  float lambert = max(dot(n, u_light), 0.0);
  // Where a slope faces the camera far more than the flat frame did, one
  // source row smears over many screen rows; fade those streaks into a
  // clean shaded relief in the theme's own fog colour.
  float rows = length(vec2(dFdx(uv.y), dFdy(uv.y))) * float(textureSize(u_drape, 0).y);
  float stretch = 1.0 - smoothstep(0.12, 0.4, rows);
  vec3 relief = u_fogColor * (0.78 + 0.45 * lambert);
  c = mix(c, relief, stretch * 0.85 * u_ramp);
  c *= 1.0 + (lambert - u_light.z) * u_form;
  float d = v_dist / u_ctc;
  float f = d > u_fogParams.x ? 1.0 - exp(-u_fogParams.y * (d - u_fogParams.x)) : 0.0;
  float t = clamp((d - u_fogParams.z * 0.85) / (u_fogParams.z * 0.15), 0.0, 1.0);
  f = max(f, t * t * (3.0 - 2.0 * t));
  f = max(f, clamp(topOut * 40.0, 0.0, 1.0));
  fragColor = vec4(mix(c, u_fogColor, clamp(f, 0.0, 1.0) * u_ramp), 1.0);
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

GLuint compile(GLenum type, const char* src) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, nullptr);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[1024];
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
    char log[1024];
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
constexpr int kBatch = 192;         // instances per draw (std140 block <= 16 KB)
constexpr GLuint kTilesBinding = 20;

struct TileSlot {
  int slot = -1;
  uint32_t version = 0;
  uint64_t lastFrame = 0;
};

struct GlRenderer {
  EGLContext context = EGL_NO_CONTEXT;
  bool ready = false;
  GLuint terrainProgram = 0, skyProgram = 0;
  GLuint vao = 0, skyVao = 0;
  GLuint gridVbo = 0, ibo = 0, atlasTex = 0, tilesUbo = 0;
  GLsizei indexCount = 0;
  GLuint drapeTex = 0;
  int drapeW = 0, drapeH = 0;
  std::unordered_map<uint64_t, TileSlot> tiles;
  std::vector<int> freeSlots;
  std::vector<float> ubo;  // staging, std140
  uint64_t frameNo = 0;
  struct {
    GLint atlas, hRef, scale, far, drape, light, form, exag, fogColor, fogParams, ctc, ramp;
  } tu{};
  struct {
    GLint rays, horizon, zenith, fogColor, ramp;
  } su{};

  void init() {
    context = eglGetCurrentContext();
    terrainProgram = link(kTerrainVs, kTerrainFs);
    skyProgram = link(kSkyVs, kSkyFs);
    if (!terrainProgram || !skyProgram) return;
#define TU(name) tu.name = glGetUniformLocation(terrainProgram, "u_" #name)
    TU(atlas);
    TU(hRef);
    TU(scale);
    TU(far);
    TU(drape);
    TU(light);
    TU(form);
    TU(exag);
    TU(fogColor);
    TU(fogParams);
    TU(ctc);
    TU(ramp);
#undef TU
    su.rays = glGetUniformLocation(skyProgram, "u_rays");
    su.horizon = glGetUniformLocation(skyProgram, "u_horizon");
    su.zenith = glGetUniformLocation(skyProgram, "u_zenith");
    su.fogColor = glGetUniformLocation(skyProgram, "u_fogColor");
    su.ramp = glGetUniformLocation(skyProgram, "u_ramp");

    const auto verts = buildGridVertices(kGrid);
    const auto idx32 = buildGridIndices(kGrid);
    std::vector<uint16_t> idx(idx32.begin(), idx32.end());
    indexCount = static_cast<GLsizei>(idx.size());
    glGenVertexArrays(1, &vao);
    glGenVertexArrays(1, &skyVao);
    glGenBuffers(1, &gridVbo);
    glGenBuffers(1, &ibo);
    glUniformBlockBinding(terrainProgram, glGetUniformBlockIndex(terrainProgram, "Tiles"), kTilesBinding);
    glGenBuffers(1, &tilesUbo);
    glBindBuffer(GL_UNIFORM_BUFFER, tilesUbo);
    glBufferData(GL_UNIFORM_BUFFER, kBatch * 80, nullptr, GL_DYNAMIC_DRAW);
    glBindBuffer(GL_UNIFORM_BUFFER, 0);
    glGenTextures(1, &atlasTex);
    glBindTexture(GL_TEXTURE_2D, atlasTex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, kAtlasWidth, kAtlasSlots, 0, GL_RGBA, GL_FLOAT, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    freeSlots.clear();
    for (int i = kAtlasSlots - 1; i >= 0; i--) freeSlots.push_back(i);
    ubo.assign(kBatch * 20, 0.f);
    glBindVertexArray(vao);
    glBindBuffer(GL_ARRAY_BUFFER, gridVbo);
    glBufferData(GL_ARRAY_BUFFER, verts.size() * sizeof(float), verts.data(), GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), nullptr);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, idx.size() * sizeof(uint16_t), idx.data(), GL_STATIC_DRAW);
    glBindVertexArray(0);
    glGenTextures(1, &drapeTex);
    ready = true;
    LOGI("GL renderer ready");
  }

  void forget() {  // context lost: handles are gone with it
    *this = GlRenderer{};
  }

  void destroy() {
    if (eglGetCurrentContext() != context || context == EGL_NO_CONTEXT) {
      forget();
      return;
    }
    if (terrainProgram) glDeleteProgram(terrainProgram);
    if (skyProgram) glDeleteProgram(skyProgram);
    glDeleteVertexArrays(1, &vao);
    glDeleteVertexArrays(1, &skyVao);
    glDeleteBuffers(1, &gridVbo);
    glDeleteBuffers(1, &ibo);
    glDeleteBuffers(1, &tilesUbo);
    glDeleteTextures(1, &atlasTex);
    glDeleteTextures(1, &drapeTex);
    forget();
  }

  void ensureDrape(int w, int h) {
    if (w == drapeW && h == drapeH) return;
    glBindTexture(GL_TEXTURE_2D, drapeTex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    drapeW = w;
    drapeH = h;
  }

  /** The tile's atlas row (uploaded if its heights changed), or -1 for a flat tile. */
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
      // Upload through the atlas's own unit: binding it on unit 0 would
      // replace the drape mid-draw (heights sampled as colour).
      glActiveTexture(GL_TEXTURE1);
      glBindTexture(GL_TEXTURE_2D, atlasTex);
      glTexSubImage2D(GL_TEXTURE_2D, 0, 0, t.slot, vertexCount(kGrid), 1, GL_RGBA, GL_FLOAT,
                      d.attributes->data());
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

  void draw(const FrameOutput& out) {
    frameNo++;
    GLint vp[4];
    glGetIntegerv(GL_VIEWPORT, vp);
    if (vp[2] <= 0 || vp[3] <= 0) return;
    ensureDrape(vp[2], vp[3]);

    // 1. Capture what MapLibre drew (every layer below us).
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, drapeTex);
    const int dbg = out.look.debugFlags;
    if (!(dbg & 1)) glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, vp[0], vp[1], vp[2], vp[3]);

    glDisable(GL_STENCIL_TEST);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_CULL_FACE);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);

    // 2. Sky (and fog below the horizon), blended in with the ramp.
    glDisable(GL_DEPTH_TEST);
    glDepthMask(GL_FALSE);
    glEnable(GL_BLEND);
    glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ZERO, GL_ONE);
    glUseProgram(skyProgram);
    glUniform4fv(su.rays, 3, &out.skyRays[0][0]);
    glUniform3fv(su.horizon, 1, out.look.skyHorizon);
    glUniform3fv(su.zenith, 1, out.look.skyZenith);
    glUniform3fv(su.fogColor, 1, out.look.fogColor);
    glUniform1f(su.ramp, out.ramp);
    glBindVertexArray(skyVao);
    if (!(dbg & 4) && out.skyVisible) glDrawArrays(GL_TRIANGLES, 0, 3);

    // 3. Terrain, front to back, our own depth.
    glDisable(GL_BLEND);
    glDepthMask(GL_TRUE);
    glClearDepthf(1.0f);
    glClear(GL_DEPTH_BUFFER_BIT);
    glEnable(GL_DEPTH_TEST);
    glDepthFunc(GL_LESS);
    glDepthRangef(0.0f, 1.0f);
    glUseProgram(terrainProgram);
    glUniform1i(tu.drape, 0);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, atlasTex);
    glUniform1i(tu.atlas, 1);
    glActiveTexture(GL_TEXTURE0);
    glUniform3fv(tu.light, 1, out.light);
    glUniform1f(tu.form, out.look.formStrength * 2.0f * out.ramp);
    glUniform1f(tu.exag, out.exaggeration);
    glUniform3fv(tu.fogColor, 1, out.look.fogColor);
    glUniform3f(tu.fogParams, out.look.fogStartCtc, out.look.fogDensity, out.look.fogEndCtc);
    glUniform1f(tu.ctc, out.ctc);
    glUniform1f(tu.ramp, out.ramp);
    glUniform1f(tu.hRef, out.hRef);
    glUniform1f(tu.scale, out.exaggeration * out.ramp);
    glUniform1f(tu.far, out.farW);
    glBindVertexArray(vao);
    glBindBufferBase(GL_UNIFORM_BUFFER, kTilesBinding, tilesUbo);
    const size_t total = (dbg & 2) ? 0 : out.tiles.size();
    for (size_t start = 0; start < total; start += kBatch) {
      const int n = static_cast<int>(std::min<size_t>(kBatch, total - start));
      for (int i = 0; i < n; i++) {
        const DrawTile& d = out.tiles[start + i];
        const int slot = slotFor(d);
        std::copy(d.matrix, d.matrix + 16, ubo.begin() + i * 16);
        float* pp = ubo.data() + kBatch * 16 + i * 4;
        pp[0] = slot < 0 ? 1.f : d.morph;
        pp[1] = slot < 0 ? 1.f : d.fromFlat;
        pp[2] = d.skirtDepth * out.ramp;
        pp[3] = static_cast<float>(slot);
      }
      glBindBuffer(GL_UNIFORM_BUFFER, tilesUbo);
      glBufferSubData(GL_UNIFORM_BUFFER, 0, kBatch * 16 * sizeof(float), ubo.data());
      glBufferSubData(GL_UNIFORM_BUFFER, kBatch * 16 * sizeof(float), kBatch * 4 * sizeof(float),
                      ubo.data() + kBatch * 16);
      glDrawElementsInstanced(GL_TRIANGLES, indexCount, GL_UNSIGNED_SHORT, nullptr, n);
    }
    glBindBuffer(GL_UNIFORM_BUFFER, 0);
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
  jmethodID requestDem = nullptr, requestRepaint = nullptr;
  std::unique_ptr<Engine> engine;
  GlRenderer gl;
  std::mutex glMutex;  // gl state is render-thread only; guards host handover
  std::atomic<bool> enabled{true};
  std::atomic<bool> detached{false};
  std::atomic<bool> recording{false};
  std::mutex timesMutex;
  std::vector<int64_t> frameTimes;      // render() entry, ns
  std::vector<int64_t> renderCostNs;    // our work per frame, ns
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
      w_->gl.draw(out);
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
  w->requestRepaint = env->GetMethodID(cls, "requestRepaint", "()V");
  Wrapper* raw = w.get();
  w->engine = std::make_unique<Engine>(
      [raw](int z, int x, int y) {
        JNIEnv* e = raw->env();
        if (e && raw->bridge) e->CallVoidMethod(raw->bridge, raw->requestDem, z, x, y);
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
  // [exaggeration, fog rgb, horizon rgb, zenith rgb, form, fogStart, fogDensity, fogEnd]
  const jsize n = env->GetArrayLength(values);
  if (n < 14) return;
  jfloat v[15] = {};
  env->GetFloatArrayRegion(values, 0, n < 15 ? n : 15, v);
  LookParams look;
  look.exaggeration = v[0];
  for (int i = 0; i < 3; i++) {
    look.fogColor[i] = v[1 + i];
    look.skyHorizon[i] = v[4 + i];
    look.skyZenith[i] = v[7 + i];
  }
  look.formStrength = v[10];
  look.fogStartCtc = v[11];
  look.fogDensity = v[12];
  look.fogEndCtc = v[13];
  look.debugFlags = static_cast<int>(v[14]);
  (*handle(h))->engine->setLook(look);
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
                      static_cast<double>(w->gl.tiles.size())};
  jdoubleArray arr = env->NewDoubleArray(12);
  env->SetDoubleArrayRegion(arr, 0, 12, v);
  return arr;
}

}  // extern "C"
