#include "terrain_engine.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

#include "png_decode.hpp"

namespace inukshuk::terrain {

namespace {
constexpr int N = Engine::kGridN;

double tileCenterLat(const TileId& t) {
  const double n = std::pow(2.0, t.z);
  return mercYToLat((t.y + 0.5) / n);
}

uint64_t meshKeyOf(const TileId& t) { return meshKey(t.z, t.x, t.y); }

double nowCpuMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}
}  // namespace

Engine::Engine(RequestFn request, RepaintFn repaint)
    : request_(std::move(request)), repaint_(std::move(repaint)) {}

void Engine::setLook(const LookParams& look) {
  std::lock_guard<std::mutex> lock(mutex_);
  look_ = look;
}

LookParams Engine::look() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return look_;
}

// ---- DEM cache ---------------------------------------------------------------

std::shared_ptr<const Engine::Dem> Engine::demLocked(const DemId& d) const {
  auto it = dems_.find(demKey64(d));
  return it == dems_.end() ? nullptr : it->second.dem;
}

bool Engine::demLoadedLocked(const DemId& d) const { return dems_.count(demKey64(d)) > 0; }

void Engine::touchDemLocked(uint64_t key) {
  auto it = dems_.find(key);
  if (it == dems_.end()) return;
  demLru_.splice(demLru_.end(), demLru_, it->second.lru);
}

void Engine::evictDemsLocked() {
  for (auto it = demLru_.begin(); it != demLru_.end() && demBytes_ > kDemBudgetBytes;) {
    const uint64_t k = *it;
    if (demPins_.count(k)) {
      ++it;
      continue;
    }
    auto e = dems_.find(k);
    if (e != dems_.end()) {
      demBytes_ -= e->second.dem->heights.size() * sizeof(float);
      dems_.erase(e);
    }
    it = demLru_.erase(it);
  }
}

void Engine::insertDem(const DemId& d, std::vector<float> heights) {
  auto dem = std::make_shared<Dem>();
  const auto [mn, mx] = demStats(heights);
  dem->minH = mn;
  dem->maxH = mx;
  dem->heights = std::move(heights);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const uint64_t k = demKey64(d);
    pending_.erase(k);
    failedAt_.erase(k);
    auto it = dems_.find(k);
    if (it != dems_.end()) {
      demBytes_ -= it->second.dem->heights.size() * sizeof(float);
      demLru_.erase(it->second.lru);
      dems_.erase(it);
    }
    demBytes_ += dem->heights.size() * sizeof(float);
    demLru_.push_back(k);
    dems_[k] = DemEntry{std::move(dem), std::prev(demLru_.end())};
    evictDemsLocked();
  }
  demGeneration_++;
  if (repaint_) repaint_();
}

bool Engine::onDemData(int z, int x, int y, const uint8_t* png, size_t size) {
  DecodedImage img;
  std::string error;
  if (!decodePng(png, size, img, error) || img.width != img.height || img.width < 2) {
    onDemFailed(z, x, y);
    return false;
  }
  auto heights = decodeTerrarium(img.pixels.data(), img.width, img.height, img.channels);
  if (img.width != kDemSize) {
    // Resample to the engine's DEM size (Terrarium is 256; be tolerant).
    std::vector<float> r(static_cast<size_t>(kDemSize) * kDemSize);
    for (int j = 0; j < kDemSize; j++)
      for (int i = 0; i < kDemSize; i++)
        r[j * kDemSize + i] = static_cast<float>(sampleDem(heights.data(), img.width,
                                                           (i + 0.5) / kDemSize,
                                                           (j + 0.5) / kDemSize));
    heights = std::move(r);
  }
  insertDem({z, x, y}, std::move(heights));
  return true;
}

void Engine::onDemHeights(int z, int x, int y, std::vector<float> heights) {
  insertDem({z, x, y}, std::move(heights));
}

void Engine::onDemFailed(int z, int x, int y) {
  failed_++;
  std::lock_guard<std::mutex> lock(mutex_);
  const uint64_t k = demKey64({z, x, y});
  pending_.erase(k);
  failedAt_[k] = clockMs_;
}

void Engine::trimMemory() {
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto it = demLru_.begin(); it != demLru_.end();) {
    if (demPins_.count(*it)) {
      ++it;
      continue;
    }
    auto e = dems_.find(*it);
    if (e != dems_.end()) {
      demBytes_ -= e->second.dem->heights.size() * sizeof(float);
      dems_.erase(e);
    }
    it = demLru_.erase(it);
  }
  // Meshes are render-thread state; mark for the next frame by shrinking the
  // pins to the current set (frame() trims unpinned meshes past budget).
}

void Engine::reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  dems_.clear();
  demLru_.clear();
  demBytes_ = 0;
  pending_.clear();
  failedAt_.clear();
  demPins_.clear();
  resetMeshes_ = true;  // render-thread state: cleared by the next frame()
}

std::optional<double> Engine::heightAt(double mercX, double mercY, int maxZoom) const {
  if (!std::isfinite(mercX) || !std::isfinite(mercY) || mercY < 0 || mercY >= 1)
    return std::nullopt;
  const double mx = mercX - std::floor(mercX);
  std::lock_guard<std::mutex> lock(mutex_);
  for (int z = std::min(maxZoom, kDemMaxZoom); z >= 0; z--) {
    const double n = std::pow(2.0, z);
    const int x = std::min(static_cast<int>(mx * n), static_cast<int>(n) - 1);
    const int y = std::min(static_cast<int>(mercY * n), static_cast<int>(n) - 1);
    auto dem = demLocked({z, x, y});
    if (dem) return sampleDem(dem->heights.data(), kDemSize, mx * n - x, mercY * n - y);
  }
  return std::nullopt;
}

EngineStats Engine::stats() const {
  EngineStats s = stats_;
  std::lock_guard<std::mutex> lock(mutex_);
  s.demCount = static_cast<int>(dems_.size());
  s.demBytes = demBytes_;
  s.inFlight = static_cast<int>(pending_.size());
  s.requested = requested_.load();
  s.failed = failed_.load();
  return s;
}

// ---- meshes --------------------------------------------------------------------

float Engine::morphOf(const Mesh& m, double now) const {
  return static_cast<float>(morphFactor(now - m.morphStart));
}

bool Engine::bake(const TileId& t, int demZoom, double now) {
  const DemWindow w = demWindowAt(t, demZoom);
  std::array<std::shared_ptr<const Dem>, 9> hold;
  DemNeighborhood nb;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        std::shared_ptr<const Dem> d;
        if (dx == 0 && dy == 0) {
          d = demLocked(w.dem);
        } else if (auto n = demNeighbor(w.dem, dx, dy)) {
          d = demLocked(*n);
        }
        hold[(dy + 1) * 3 + (dx + 1)] = d;
      }
    }
  }
  if (!hold[4]) return false;
  nb.size = kDemSize;
  nb.center = hold[4]->heights.data();
  for (int i = 0; i < 9; i++) nb.around[i] = hold[i] ? hold[i]->heights.data() : nullptr;

  auto sampler = [&](double u, double v) {
    return sampleMosaic(nb, w.offsetX + u * w.scale, w.offsetY + v * w.scale);
  };
  std::vector<float> hTo = bakeHeights(N, sampler);
  const double cellMeters = tileSizeMeters(t.z, tileCenterLat(t)) / N;
  std::vector<float> slopes = bakeSlopes(N, sampler, cellMeters);

  const uint64_t key = meshKeyOf(t);
  std::vector<float> hFrom;
  bool fromFlat = false;
  auto existing = meshes_.find(key);
  if (existing != meshes_.end()) {
    const Mesh& old = existing->second;
    const float m = morphOf(old, now);
    if (old.fromFlat && m > 0.5f) {
      fromFlat = true;
    } else {
      hFrom.resize(old.hTo.size());
      for (size_t k = 0; k < hFrom.size(); k++)
        hFrom[k] = old.fromFlat ? old.hTo[k] : old.hTo[k] + (old.hFrom[k] - old.hTo[k]) * m;
    }
  } else {
    // The surface currently drawn there: the nearest cached ancestor's.
    bool found = false;
    for (int up = 1; up <= 4 && t.z - up >= 0 && !found; up++) {
      const TileId a{t.z - up, t.x >> up, t.y >> up, t.wrap};
      auto it = meshes_.find(meshKeyOf(a));
      if (it == meshes_.end()) continue;
      if (up == 1) {
        hFrom = parentSurfaceForChild(N, it->second.hTo, t.x & 1, t.y & 1);
      } else {
        const double k = std::pow(2.0, up);
        const double ox = (t.x - a.x * k) / k, oy = (t.y - a.y * k) / k;
        const auto& ah = it->second.hTo;
        hFrom = bakeHeights(N, [&](double u, double v) {
          return surfaceAt(N, ah, ox + u / k, oy + v / k);
        });
      }
      found = true;
    }
    if (!found) fromFlat = true;
  }
  if (hFrom.empty()) hFrom = hTo;

  Mesh mesh;
  mesh.demZoom = demZoom;
  float mn = hTo[0], mx = hTo[0];
  for (size_t k = 0; k < hTo.size(); k++) {
    mn = std::min({mn, hTo[k], hFrom[k]});
    mx = std::max({mx, hTo[k], hFrom[k]});
  }
  mesh.minH = mn;
  mesh.maxH = mx;
  mesh.attributes =
      std::make_shared<const std::vector<float>>(packAttributes(N, hFrom, hTo, slopes));
  mesh.hTo = std::move(hTo);
  mesh.hFrom = std::move(hFrom);
  mesh.morphStart = now;
  mesh.fromFlat = fromFlat;
  mesh.version = ++versionCounter_;
  if (existing != meshes_.end()) {
    mesh.lru = existing->second.lru;
    meshLru_.splice(meshLru_.end(), meshLru_, mesh.lru);
    existing->second = std::move(mesh);
  } else {
    meshLru_.push_back(key);
    mesh.lru = std::prev(meshLru_.end());
    meshes_.emplace(key, std::move(mesh));
  }
  return true;
}

// ---- frame -----------------------------------------------------------------------

FrameOutput Engine::frame(const FrameInput& in) {
  const double cpuStart = nowCpuMs();
  FrameOutput out;
  const double now = in.timeMs;
  const double dt = lastTimeMs_ < 0 ? 0 : now - lastTimeMs_;
  lastTimeMs_ = now;
  clockMs_ = now;
  stats_.bakedThisFrame = 0;

  out.look = look();
  out.ramp = static_cast<float>(pitchRamp(in.pitchDeg));
  if (out.ramp <= 0 || in.width <= 0 || in.height <= 0) {
    stats_.tilesDrawn = 0;
    return out;
  }
  out.active = true;
  const double exag = out.look.exaggeration;
  out.exaggeration = static_cast<float>(exag);

  FrameCamera cam{in.P, in.width, in.height, in.fovRad, in.zoom, in.lat};
  const double ws = worldSize(in.zoom);
  const int refZoom = std::min(kDemMaxZoom, static_cast<int>(std::floor(in.zoom)) + 1);

  if (resetMeshes_.exchange(false)) {
    meshes_.clear();
    meshLru_.clear();
    meshPins_.clear();
    hRef_.reset();
  }

  // Reference height: the highest ground under the bottom edge.
  bool hRefSettling = false;
  if (auto invP = invert(in.P)) {
    std::vector<std::optional<double>> samples;
    for (const auto& ndc : {std::array<double, 2>{-0.9, -0.98}, std::array<double, 2>{0, -0.98},
                            std::array<double, 2>{0.9, -0.98}}) {
      auto g = groundAtNdc(*invP, ndc[0], ndc[1]);
      if (!g) continue;
      samples.push_back(heightAt(g->first / ws, g->second / ws, refZoom));
    }
    bool any = false;
    for (auto& s : samples) any = any || s.has_value();
    if (any) {
      const double target = referenceHeight(samples);
      hRef_ = smoothToward(hRef_, target, dt, 150, 0.5);
      hRefSettling = *hRef_ != target;
    }
  }
  const double hRef = hRef_.value_or(0.0);
  out.hRef = static_cast<float>(hRef);

  // LOD selection.
  LodOptions opts;
  opts.fogEndCtc = out.look.fogEndCtc;
  if (out.look.debugFlags & 8) opts.maxErrorPx = kDefaultMaxErrorPx * 2;
  opts.hRef = hRef;
  opts.heightScale = exag * out.ramp;
  opts.heightRange = [this](const TileId& t) -> std::optional<std::pair<double, double>> {
    auto it = meshes_.find(meshKeyOf(t));
    if (it != meshes_.end()) return std::make_pair<double, double>(it->second.minH, it->second.maxH);
    std::lock_guard<std::mutex> lock(mutex_);
    const DemId own = demWindow(t).dem;
    for (int z = own.z; z >= 0; z--) {
      const int k = own.z - z;
      auto d = demLocked({z, own.x >> k, own.y >> k});
      if (d) return std::make_pair<double, double>(d->minH, d->maxH);
    }
    return std::nullopt;
  };
  const Selection sel = selectTiles(cam, opts);
  out.ctc = static_cast<float>(sel.ctc);
  out.farW = static_cast<float>(out.look.fogEndCtc * sel.ctc * 1.6);
  const Vec3 light = lightDirection(in.bearingDeg);
  out.light[0] = static_cast<float>(light[0]);
  out.light[1] = static_cast<float>(light[1]);
  out.light[2] = static_cast<float>(light[2]);

  // Bakes (nearest first, budgeted) and DEM pins.
  std::unordered_set<uint64_t> pins;
  int baked = 0;
  bool bakesPending = false;
  for (const auto& s : sel.tiles) {
    std::optional<int> best;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      best = bestLoadedDemZoom(s.tile, [this](const DemId& d) { return demLoadedLocked(d); });
      if (best) {
        const DemWindow w = demWindowAt(s.tile, *best);
        pins.insert(demKey64(w.dem));
        touchDemLocked(demKey64(w.dem));
      }
      // Pin the loaded ancestors too: they bound the height ranges the LOD
      // walk uses, so dropping them would reshuffle the selection.
      const DemId own = demWindow(s.tile).dem;
      for (int z = std::min(own.z, best.value_or(own.z + 1) - 1); z >= 0; z--) {
        const int k = own.z - z;
        const uint64_t key = demKey64({z, own.x >> k, own.y >> k});
        if (dems_.count(key)) pins.insert(key);
      }
    }
    if (!best) continue;
    auto it = meshes_.find(meshKeyOf(s.tile));
    const bool stale = it == meshes_.end() || it->second.demZoom < *best;
    if (!stale) continue;
    if (baked < kBakesPerFrame) {
      if (bake(s.tile, *best, now)) baked++;
    } else {
      bakesPending = true;
    }
  }
  stats_.bakedThisFrame = baked;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    demPins_ = std::move(pins);
    evictDemsLocked();
  }

  // Draw list: a tile without a mesh borrows its nearest cached ancestor
  // (which then replaces every selected descendant, so nothing overlaps);
  // with none, it draws flat.
  std::vector<TileId> draw;
  draw.reserve(sel.tiles.size());
  std::unordered_set<std::string> substituted;
  for (const auto& s : sel.tiles) {
    if (meshes_.count(meshKeyOf(s.tile))) {
      draw.push_back(s.tile);
      continue;
    }
    bool found = false;
    for (int up = 1; up <= s.tile.z; up++) {
      const TileId a{s.tile.z - up, s.tile.x >> up, s.tile.y >> up, s.tile.wrap};
      if (meshes_.count(meshKeyOf(a))) {
        if (substituted.insert(tileKey(a)).second) draw.push_back(a);
        found = true;
        break;
      }
    }
    if (!found) draw.push_back(s.tile);  // flat
  }
  if (!substituted.empty()) {
    std::vector<TileId> pruned;
    pruned.reserve(draw.size());
    for (const auto& t : draw) {
      bool covered = false;
      for (const auto& other : draw) {
        if (isAncestorOf(other, t) && substituted.count(tileKey(other))) {
          covered = true;
          break;
        }
      }
      if (!covered) pruned.push_back(t);
    }
    draw = std::move(pruned);
  }

  bool morphing = false;
  meshPins_.clear();
  int flat = 0;
  for (const auto& t : draw) {
    const TileBounds b = tileBoundsPx(t, in.zoom);
    const Mat4 m = multiply(in.P, multiply(translation(b.minX, b.minY, 0), scaling(b.size, b.size, 1)));
    DrawTile d;
    d.key = meshKeyOf(t);
    for (int i = 0; i < 16; i++) d.matrix[i] = static_cast<float>(m[i]);
    d.skirtDepth = static_cast<float>(skirtDepth(tileSizeMeters(t.z, tileCenterLat(t))));
    auto it = meshes_.find(d.key);
    if (it != meshes_.end()) {
      const Mesh& mesh = it->second;
      d.version = mesh.version;
      d.attributes = mesh.attributes;
      d.morph = morphOf(mesh, now);
      d.fromFlat = mesh.fromFlat ? 1.f : 0.f;
      morphing = morphing || d.morph > 0;
      meshPins_.insert(d.key);
      meshLru_.splice(meshLru_.end(), meshLru_, mesh.lru);
    } else {
      d.version = 0;
      d.morph = 1;
      d.fromFlat = 1;
      flat++;
    }
    out.tiles.push_back(std::move(d));
  }
  // Mesh LRU trim.
  for (auto it = meshLru_.begin(); it != meshLru_.end() && meshes_.size() > kMeshBudget;) {
    if (meshPins_.count(*it)) {
      ++it;
      continue;
    }
    meshes_.erase(*it);
    it = meshLru_.erase(it);
  }

  // DEM requests.
  {
    std::vector<TileId> visible;
    visible.reserve(sel.tiles.size());
    for (const auto& s : sel.tiles) visible.push_back(s.tile);
    std::vector<DemId> plan;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      const int room = kMaxInFlight - static_cast<int>(pending_.size());
      if (room > 0) {
        plan = planDemRequests(
            visible, in.bearingDeg, [this](const DemId& d) { return demLoadedLocked(d); },
            [this, now](const DemId& d) {
              const uint64_t k = demKey64(d);
              if (pending_.count(k)) return true;
              auto f = failedAt_.find(k);
              return f != failedAt_.end() && now - f->second < kRetryMs;
            },
            std::min(room, kRequestsPerFrame));
        for (const auto& d : plan) pending_.insert(demKey64(d));
      }
    }
    for (const auto& d : plan) {
      requested_++;
      if (request_) request_(d.z, d.x, d.y);
    }
  }

  // Sky rays (camera-relative far points of the full-screen triangle).
  if (auto invP = invert(in.P); invP && sel.eye) {
    const double ppm = pixelsPerMeter(in.lat, in.zoom);
    const double corners[3][2] = {{-1, -1}, {3, -1}, {-1, 3}};
    for (int i = 0; i < 3; i++) {
      const Vec4 v = transform(*invP, {corners[i][0], corners[i][1], 1, 1});
      const Vec3& e = *sel.eye;
      out.skyRays[i][0] = static_cast<float>(v[0] - e[0] * v[3]);
      out.skyRays[i][1] = static_cast<float>(v[1] - e[1] * v[3]);
      out.skyRays[i][2] = static_cast<float>((v[2] - e[2] * v[3]) * ppm);
      out.skyRays[i][3] = static_cast<float>(v[3]);
    }
  }

  out.needsRepaint = morphing || bakesPending || hRefSettling;
  stats_.tilesDrawn = static_cast<int>(out.tiles.size());
  stats_.flatTiles = flat;
  stats_.meshCount = static_cast<int>(meshes_.size());
  stats_.lastFrameCpuMs = nowCpuMs() - cpuStart;
  return out;
}

}  // namespace inukshuk::terrain
