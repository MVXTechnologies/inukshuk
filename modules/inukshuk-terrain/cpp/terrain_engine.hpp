// The stateful terrain engine shared by the GLES (Android) and Metal (iOS)
// renderers: DEM cache, per-tile height meshes, LOD selection, morphs and
// the per-frame draw list. Backend-agnostic — the renderers only upload the
// attribute buffers it hands out and issue the draws.
//
// Threads: `frame()` runs on the render thread; `onDemData`/`onDemFailed`
// on any worker thread (they decode the PNG there); `setLook`/`trimMemory`
// on any thread.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "terrain_core.hpp"

namespace inukshuk::terrain {

struct LookParams {
  float exaggeration = 1.0f;
  float fogColor[3] = {0.95f, 0.93f, 0.88f};
  float skyHorizon[3] = {0.96f, 0.95f, 0.91f};
  float skyZenith[3] = {0.85f, 0.88f, 0.9f};
  float formStrength = 0.22f;
  float fogStartCtc = 2.5f;
  float fogDensity = 0.12f;
  float fogEndCtc = 12.0f;
  /** QA only: 1 = skip the frame copy, 2 = skip terrain, 4 = skip sky, 8 = half the tiles' detail. */
  int debugFlags = 0;
};

struct FrameInput {
  Mat4 P{};
  double width = 0, height = 0;  // logical px
  double fovRad = 0.6435011087932844;
  double zoom = 0;
  double lat = 0, lng = 0;
  double bearingDeg = 0;
  double pitchDeg = 0;
  double timeMs = 0;
};

struct DrawTile {
  uint64_t key = 0;
  /** Bumped whenever `attributes` change; the renderer re-uploads on change. */
  uint32_t version = 0;
  /** Interleaved [hFrom, hTo, slopeX, slopeY] per vertex; null = a flat tile. */
  std::shared_ptr<const std::vector<float>> attributes;
  float matrix[16] = {};
  float morph = 0;
  float fromFlat = 0;
  float skirtDepth = 0;
};

struct FrameOutput {
  bool active = false;
  float ramp = 0;
  float hRef = 0;
  float exaggeration = 1;
  float ctc = 1;
  float farW = 1;
  float light[3] = {0, 0, 1};
  /** Camera-relative homogeneous far-plane points (x, y, z_px, w) of the full-screen
   * triangle (-1,-1), (3,-1), (-1,3); dir = xyz / w. */
  float skyRays[3][4] = {};
  /** The horizon (or above) is on screen: the sky pass is needed. */
  bool skyVisible = true;
  LookParams look;
  std::vector<DrawTile> tiles;
  bool needsRepaint = false;
};

struct EngineStats {
  int demCount = 0;
  size_t demBytes = 0;
  int meshCount = 0;
  int tilesDrawn = 0;
  int flatTiles = 0;
  int bakedThisFrame = 0;
  int inFlight = 0;
  int requested = 0;
  int failed = 0;
  double lastFrameCpuMs = 0;
};

class Engine {
 public:
  using RequestFn = std::function<void(int z, int x, int y)>;
  using RepaintFn = std::function<void()>;

  static constexpr int kGridN = kGrid;
  static constexpr size_t kDemBudgetBytes = 48u * 1024u * 1024u;
  static constexpr size_t kMeshBudget = 600;
  static constexpr int kBakesPerFrame = 8;
  static constexpr int kMaxInFlight = 16;
  static constexpr int kRequestsPerFrame = 8;
  static constexpr double kRetryMs = 30000;

  Engine(RequestFn request, RepaintFn repaint);

  void setLook(const LookParams& look);
  LookParams look() const;

  /** PNG bytes for a DEM tile (decoded on the calling thread). */
  bool onDemData(int z, int x, int y, const uint8_t* png, size_t size);
  /** Raw decoded heights (tests / pre-decoded sources). */
  void onDemHeights(int z, int x, int y, std::vector<float> heights);
  void onDemFailed(int z, int x, int y);

  /** Low-memory: drop every DEM and mesh not needed by the last frame. */
  void trimMemory();
  /** Forget everything (detach). */
  void reset();

  FrameOutput frame(const FrameInput& in);

  EngineStats stats() const;
  /** Height (m) at a mercator point from the best loaded DEM, or nullopt. */
  std::optional<double> heightAt(double mercX, double mercY, int maxZoom) const;

 private:
  struct Dem {
    std::vector<float> heights;
    float minH = 0, maxH = 0;
  };
  struct DemEntry {
    std::shared_ptr<const Dem> dem;
    std::list<uint64_t>::iterator lru;
  };
  struct Mesh {
    int demZoom = -1;
    std::vector<float> hTo, hFrom;
    std::shared_ptr<const std::vector<float>> attributes;
    float minH = 0, maxH = 0;
    double morphStart = 0;
    bool fromFlat = false;
    uint32_t version = 0;
    std::list<uint64_t>::iterator lru;
  };

  std::shared_ptr<const Dem> demLocked(const DemId& d) const;
  bool demLoadedLocked(const DemId& d) const;
  void insertDem(const DemId& d, std::vector<float> heights);
  void touchDemLocked(uint64_t key);
  void evictDemsLocked();

  bool bake(const TileId& t, int demZoom, double now);
  float morphOf(const Mesh& m, double now) const;

  RequestFn request_;
  RepaintFn repaint_;

  mutable std::mutex mutex_;  // DEM cache, pending, failed, look
  std::unordered_map<uint64_t, DemEntry> dems_;
  std::list<uint64_t> demLru_;  // front = least recent
  size_t demBytes_ = 0;
  std::unordered_set<uint64_t> pending_;
  std::unordered_map<uint64_t, double> failedAt_;
  std::unordered_set<uint64_t> demPins_;
  LookParams look_;
  std::atomic<uint32_t> demGeneration_{0};
  std::atomic<bool> resetMeshes_{false};
  std::atomic<bool> trimMeshes_{false};

  // Render-thread only.
  std::unordered_map<uint64_t, Mesh> meshes_;
  std::list<uint64_t> meshLru_;
  std::unordered_set<uint64_t> meshPins_;
  uint32_t versionCounter_ = 0;
  std::optional<double> hRef_;
  double lastTimeMs_ = -1;
  double clockMs_ = 0;  // engine clock for failures (render-thread time)
  std::vector<float> gridVertices_;
  EngineStats stats_;
  std::atomic<int> requested_{0};
  std::atomic<int> failed_{0};
};

}  // namespace inukshuk::terrain
