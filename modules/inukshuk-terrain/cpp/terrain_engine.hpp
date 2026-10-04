// The stateful 3D scene engine shared by the GLES (Android) and Metal (iOS)
// renderers (docs/plans/native-terrain.md, #551 redesign: a true 3D scene,
// no draping). It owns the DEM cache, per-tile meshes and their detail
// textures (slopes + water/glacier masks), the LOD selection and morphs,
// satellite imagery slots, the 3D pin labels' placement, the lifted trails
// and the location marker — and hands the renderer a per-frame draw list.
//
// Threads: `frame()` runs on the render thread; `onDemData`, `onImageryData`
// and the `on…Failed` calls on any worker thread; the `set…` calls on any
// thread (usually UI). Mesh baking runs on the engine's own worker thread.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "terrain_core.hpp"

namespace inukshuk::terrain {

/** Per-tile detail texture: 64×64 RGBA8 — slopeX, slopeY (encoded), water, glacier. */
constexpr int kDetailSize = 64;
/** Slopes (m/m) are stored as s / kSlopeRange · ½ + ½. */
constexpr double kSlopeRange = 4.0;
constexpr int kImageryMaxZoom = 18;
constexpr int kImagerySize = 256;

struct LookParams {
  float exaggeration = 1.0f;
  float fogColor[3] = {0.95f, 0.93f, 0.88f};
  float skyHorizon[3] = {0.96f, 0.95f, 0.91f};
  float skyZenith[3] = {0.85f, 0.88f, 0.9f};
  float formStrength = 0.22f;
  float fogStartCtc = 2.5f;
  float fogDensity = 0.12f;
  float fogEndCtc = 12.0f;
  float land[3] = {0.95f, 0.93f, 0.88f};
  float rock[3] = {0.9f, 0.87f, 0.81f};
  float water[3] = {0.55f, 0.7f, 0.8f};
  float glacier[3] = {0.95f, 0.96f, 0.97f};
  float shadow[3] = {0.4f, 0.35f, 0.28f};
  float highlight[3] = {1.0f, 0.98f, 0.95f};
  float contour[3] = {0.7f, 0.55f, 0.35f};
  float contourMajor[3] = {0.5f, 0.38f, 0.22f};
  float contourOpacity = 0.95f;
  float imagery = 0.0f;
  /** QA only: 2 = skip terrain, 4 = skip sky, 8 = coarser LOD. */
  int debugFlags = 0;
};

/** Unpack the 40 (+1 debug) floats of `packLook` (src/core/terrain3d/look.ts). */
LookParams lookFromFloats(const float* v, int n);

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
  /** Bumped whenever `attributes`/`detail` change; the renderer re-uploads on change. */
  uint32_t version = 0;
  /** Interleaved [hFrom, hTo, slopeX, slopeY] per vertex; null = a flat tile. */
  std::shared_ptr<const std::vector<float>> attributes;
  /** kDetailSize² RGBA8; null with `attributes`. */
  std::shared_ptr<const std::vector<uint8_t>> detail;
  float matrix[16] = {};
  float morph = 0;
  float fromFlat = 0;
  float skirtDepth = 0;
  /** Satellite: imagery slots (-1 none) with their window (offX, offY, scale) in the slot. */
  int imgA = -1, imgB = -1;
  float winA[3] = {0, 0, 1}, winB[3] = {0, 0, 1};
  /** 0 → show A, 1 → show B (crossfade on an imagery upgrade). */
  float imgBlend = 0;
};

struct LabelData {
  int id = 0;
  double mercX = 0, mercY = 0;
  int kind = 0;  // 0 peak, 1 place, 2 poi, 3 water
  double priority = 0;
  /** Plate size (logical px) and its atlas rect (texture uv). */
  float w = 0, h = 0;
  float u0 = 0, v0 = 0, u1 = 0, v1 = 0;
};

struct LabelDraw {
  int id = 0;
  /** Plate rect (logical px, origin top-left), ground point, opacity, atlas uv. */
  float x0 = 0, y0 = 0, x1 = 0, y1 = 0, gx = 0, gy = 0, opacity = 0, scale = 1;
  float u0 = 0, v0 = 0, u1 = 0, v1 = 0;
  int kind = 0;
};

struct LineStyle {
  float color[4] = {1, 0.4f, 0.1f, 1};
  float halo[4] = {1, 1, 1, 0.9f};
  float width = 3.5f, haloWidth = 6.0f;
  int order = 0;
};

struct LineDraw {
  int id = 0;
  uint32_t version = 0;
  /** 6 vertices per segment × [ax, ay, ah, bx, by, bh, side, end]. */
  std::shared_ptr<const std::vector<float>> vertices;
  float matrix[16] = {};
  LineStyle style;
};

struct PuckDraw {
  bool visible = false;
  float gx = 0, gy = 0;  // logical px
  float opacity = 1;
};

struct ImageryUpload {
  int slot = 0;
  /** Edge length of level 0 (px) and the number of mip levels in `pixels`. */
  int size = kImagerySize;
  int levels = 1;
  /** RGBA8: level 0 (size²), then each mip level (see buildMipChain), tightly packed. */
  std::shared_ptr<const std::vector<uint8_t>> pixels;
};

struct FrameOutput {
  bool active = false;
  /** Logical viewport size (px): label and line geometry is in these units. */
  float width = 0, height = 0;
  float ramp = 0;
  float hRef = 0;
  float exaggeration = 1;
  float ctc = 1;
  float farW = 1;
  float light[3] = {0, 0, 1};
  float skyRays[3][4] = {};
  bool skyVisible = true;
  int contourBase = 0;
  LookParams look;
  std::vector<DrawTile> tiles;
  std::vector<LabelDraw> labels;
  std::vector<LineDraw> lines;
  PuckDraw puck;
  std::vector<ImageryUpload> imageryUploads;
  bool needsRepaint = false;
  /** Drape mode: tiles sample the per-tile render of the 2D map style (crisp map, contours included). */
  bool drape = false;
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
  int labelsShown = 0;
  int imagerySlots = 0;
  int bakeQueue = 0;
};

class Engine {
 public:
  using RequestFn = std::function<void(int z, int x, int y)>;
  using RepaintFn = std::function<void()>;

  static constexpr int kGridN = kGrid;
  static constexpr size_t kDemBudgetBytes = 48u * 1024u * 1024u;
  static constexpr size_t kMeshBudget = 600;
  static constexpr int kMaxBakeJobs = 24;
  static constexpr int kMaxInFlight = 16;
  static constexpr int kRequestsPerFrame = 8;
  static constexpr double kRetryMs = 30000;
  static constexpr int kImagerySlots = 192;
  static constexpr int kImageryUploadsPerFrame = 6;
  static constexpr double kImageryFadeMs = 300;
  /** Unrequested drape textures (block siblings) kept CPU-side, waiting to be wanted. */
  static constexpr size_t kMaxUnwantedImagery = 48;

  /**
   * `meshGrid`: cells per tile edge of the baked meshes (the LOD still splits
   * on the kGrid spacing, so a finer mesh sharpens ridges without more tiles).
   */
  Engine(RequestFn demRequest, RequestFn imageryRequest, RepaintFn repaint, int meshGrid = kGrid);
  int meshGrid() const { return meshGrid_; }
  ~Engine();

  void setLook(const LookParams& look);
  LookParams look() const;

  bool onDemData(int z, int x, int y, const uint8_t* png, size_t size);
  void onDemHeights(int z, int x, int y, std::vector<float> heights);
  void onDemFailed(int z, int x, int y);

  /** Decoded imagery (kImagerySize² RGBA8) for a satellite tile. */
  void onImageryData(int z, int x, int y, std::vector<uint8_t> rgba);
  void onImageryFailed(int z, int x, int y);
  /**
   * A drape/imagery texture of any power-of-two size with its mip chain
   * (`levels` levels, buildMipChain layout). Results for a generation older
   * than the current one (see resetImagery) are dropped.
   */
  void onImageryLevels(int z, int x, int y, std::vector<uint8_t> chain, int size, int levels,
                       uint32_t generation);
  /**
   * Drape mode: every tile samples a per-tile texture rendered from the 2D map
   * style by the platform (requested through the imagery callback). `slots`
   * bounds the textures kept on the GPU.
   */
  void setDrape(bool on, int slots);
  /** Forget every imagery/drape texture (a new style); bumps the generation. */
  void resetImagery();
  uint32_t imageryGeneration() const { return imgGeneration_.load(); }

  void setLabels(std::vector<LabelData> labels);
  void setPolyline(int id, std::vector<Pt> mercPoints, const LineStyle& style);
  void removePolyline(int id);
  void setPuck(bool visible, double mercX, double mercY);
  /** UI bands (logical px) pins stay clear of: top (search/status bar) and bottom bar. */
  void setLabelInsets(double topPx, double bottomPx);
  /** Water and glacier polygons (rings in mercator [0,1]) for the surface masks. */
  void setMasks(std::vector<std::vector<Pt>> water, std::vector<std::vector<Pt>> glacier);

  void trimMemory();
  void reset();

  FrameOutput frame(const FrameInput& in);

  EngineStats stats() const;
  std::optional<double> heightAt(double mercX, double mercY, int maxZoom) const;

  /** Test hook: wait for queued bakes to finish (bounded). */
  void drainBakes(int timeoutMs = 2000);

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
    uint32_t maskGen = 0;
    std::vector<float> hTo, hFrom;
    std::shared_ptr<const std::vector<float>> attributes;
    std::shared_ptr<const std::vector<uint8_t>> detail;
    float minH = 0, maxH = 0;
    double morphStart = 0;
    bool fromFlat = false;
    uint32_t version = 0;
    std::list<uint64_t>::iterator lru;
  };
  struct MaskSet {
    std::vector<std::vector<Pt>> water, glacier;
    std::vector<std::array<double, 4>> waterBox, glacierBox;  // mercator bbox
  };
  struct BakeJob {
    TileId tile;
    int grid = kGrid;
    int demZoom = 0;
    uint32_t maskGen = 0;
    DemWindow window;
    std::array<std::shared_ptr<const Dem>, 9> dems;
    std::shared_ptr<const MaskSet> masks;
    std::vector<float> hFrom;
    bool fromFlat = false;
  };
  struct BakeResult {
    TileId tile;
    int demZoom = 0;
    uint32_t maskGen = 0;
    std::vector<float> hTo, hFrom;
    std::shared_ptr<const std::vector<float>> attributes;
    std::shared_ptr<const std::vector<uint8_t>> detail;
    float minH = 0, maxH = 0;
    bool fromFlat = false;
  };
  struct ImgEntry {
    int slot = -1;
    int size = kImagerySize, levels = 1;
    std::shared_ptr<const std::vector<uint8_t>> pending;
    /**
     * Uploaded only when wanted: requested by the engine, or asked for since it
     * arrived as a block sibling. Unwanted siblings wait CPU-side (bounded) so
     * they never evict textures still on screen.
     */
    bool wanted = false;
    uint64_t arrived = 0;
    uint64_t lastFrame = 0;
  };
  struct TileImagery {
    uint64_t key = 0;
    uint64_t prevKey = 0;
    double since = -1e300;
  };
  struct Polyline {
    std::vector<Pt> points;
    LineStyle style;
    uint32_t version = 0;
    uint32_t liftedDemGen = UINT32_MAX;
    double liftedAt = -1e300;
    double originX = 0, originY = 0;
    std::shared_ptr<const std::vector<float>> vertices;
  };
  struct LabelEntry {
    LabelData data;
    double h = 0;
    uint32_t hGen = UINT32_MAX;
  };

  std::shared_ptr<const Dem> demLocked(const DemId& d) const;
  bool demLoadedLocked(const DemId& d) const;
  void insertDem(const DemId& d, std::vector<float> heights);
  void touchDemLocked(uint64_t key);
  void evictDemsLocked();

  bool scheduleBake(const TileId& t, int demZoom, double now);
  static BakeResult runBake(const BakeJob& job);
  void installResults(double now);
  void workerLoop();
  float morphOf(const Mesh& m, double now) const;

  const int meshGrid_;
  RequestFn demRequest_, imageryRequest_;
  RepaintFn repaint_;

  mutable std::mutex mutex_;  // DEM cache, pending, failed, look, masks
  std::unordered_map<uint64_t, DemEntry> dems_;
  std::list<uint64_t> demLru_;
  size_t demBytes_ = 0;
  std::unordered_set<uint64_t> pending_;
  std::unordered_map<uint64_t, double> failedAt_;
  std::unordered_set<uint64_t> demPins_;
  LookParams look_;
  std::shared_ptr<const MaskSet> masks_;
  std::atomic<uint32_t> maskGen_{0};
  std::atomic<uint32_t> demGeneration_{0};
  std::atomic<bool> resetMeshes_{false};
  std::atomic<bool> trimMeshes_{false};

  // Imagery (own mutex: workers deliver pixels).
  mutable std::mutex imgMutex_;
  std::unordered_map<uint64_t, ImgEntry> imagery_;
  std::unordered_set<uint64_t> imgPending_;
  std::unordered_map<uint64_t, double> imgFailedAt_;
  std::vector<int> freeImgSlots_;
  uint64_t imgArrivals_ = 0;
  int imgSlotCount_ = kImagerySlots;
  std::atomic<bool> drape_{false};
  std::atomic<uint32_t> imgGeneration_{0};
  std::atomic<bool> resetTileImagery_{false};
  void resetImageryLocked(int slots);

  // Scene inputs (own mutex: UI thread writes).
  mutable std::mutex sceneMutex_;
  std::vector<LabelEntry> labels_;
  std::unordered_map<int, Polyline> polylines_;
  uint32_t lineVersion_ = 0;
  bool puckVisible_ = false;
  double labelTopPx_ = 0, labelBottomPx_ = 0;
  double puckX_ = 0, puckY_ = 0;

  // Bake worker.
  std::mutex jobMutex_;
  std::condition_variable jobCv_;
  std::deque<BakeJob> jobs_;
  std::vector<BakeResult> results_;
  bool stop_ = false;
  std::atomic<int> busy_{0};
  std::thread worker_;

  // Render-thread only.
  std::unordered_map<uint64_t, Mesh> meshes_;
  std::list<uint64_t> meshLru_;
  std::unordered_set<uint64_t> meshPins_;
  std::unordered_set<uint64_t> inProgress_;
  std::unordered_map<uint64_t, TileImagery> tileImagery_;
  std::unordered_map<int, LabelState> labelStates_;
  uint32_t versionCounter_ = 0;
  uint64_t frameNo_ = 0;
  std::optional<double> hRef_;
  double lastTimeMs_ = -1;
  double clockMs_ = 0;
  EngineStats stats_;
  std::atomic<int> requested_{0};
  std::atomic<int> failed_{0};
};

}  // namespace inukshuk::terrain
