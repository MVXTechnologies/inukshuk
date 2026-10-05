#include "terrain_engine.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

#include "png_decode.hpp"

namespace inukshuk::terrain {

namespace {

double tileCenterLat(const TileId& t) {
  const double n = std::pow(2.0, t.z);
  return mercYToLat((t.y + 0.5) / n);
}

uint64_t meshKeyOf(const TileId& t) { return meshKey(t.z, t.x, t.y); }

double nowCpuMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

uint8_t enc(double v) { return static_cast<uint8_t>(std::lround(clamp01(v) * 255.0)); }

std::array<double, 4> ringBox(const std::vector<Pt>& r) {
  std::array<double, 4> b{1e300, 1e300, -1e300, -1e300};
  for (const auto& p : r) {
    b[0] = std::min(b[0], p[0]);
    b[1] = std::min(b[1], p[1]);
    b[2] = std::max(b[2], p[0]);
    b[3] = std::max(b[3], p[1]);
  }
  return b;
}
}  // namespace

LookParams lookFromFloats(const float* v, int n) {
  LookParams l;
  if (n < 40) return l;
  int k = 0;
  l.exaggeration = v[k++];
  for (int i = 0; i < 3; i++) l.fogColor[i] = v[k + i];
  k += 3;
  for (int i = 0; i < 3; i++) l.skyHorizon[i] = v[k + i];
  k += 3;
  for (int i = 0; i < 3; i++) l.skyZenith[i] = v[k + i];
  k += 3;
  l.formStrength = v[k++];
  l.fogStartCtc = v[k++];
  l.fogDensity = v[k++];
  l.fogEndCtc = v[k++];
  float* rgb[] = {l.land, l.rock, l.water, l.glacier, l.shadow, l.highlight, l.contour, l.contourMajor};
  for (float* c : rgb) {
    for (int i = 0; i < 3; i++) c[i] = v[k + i];
    k += 3;
  }
  l.contourOpacity = v[k++];
  l.imagery = v[k++];
  if (n > 40) l.debugFlags = static_cast<int>(v[40]);
  return l;
}

Engine::Engine(RequestFn demRequest, RequestFn imageryRequest, RepaintFn repaint, int meshGrid)
    : meshGrid_(meshGrid > 0 ? meshGrid : kGrid),
      demRequest_(std::move(demRequest)),
      imageryRequest_(std::move(imageryRequest)),
      repaint_(std::move(repaint)) {
  for (int i = kImagerySlots - 1; i >= 0; i--) freeImgSlots_.push_back(i);
  masks_ = std::make_shared<MaskSet>();
  worker_ = std::thread([this] { workerLoop(); });
}

Engine::~Engine() {
  {
    std::lock_guard<std::mutex> lock(jobMutex_);
    stop_ = true;
  }
  jobCv_.notify_all();
  if (worker_.joinable()) worker_.join();
}

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

void Engine::setDemBudget(size_t bytes) {
  demBudget_ = std::max<size_t>(bytes, 16u * 1024u * 1024u);
  std::lock_guard<std::mutex> lock(mutex_);
  evictDemsLocked();
}

void Engine::evictDemsLocked() {
  // Never below what is pinned (with room for the newest arrivals), and the
  // kDemGrace most recent arrivals are never evicted: a DEM that just loaded
  // survives until the next frame pins it.
  const size_t perDem = static_cast<size_t>(kDemSize) * kDemSize * sizeof(float);
  const size_t budget = std::max(demBudget_.load(), (demPins_.size() + kDemGrace) * perDem);
  const size_t evictable = demLru_.size() > kDemGrace ? demLru_.size() - kDemGrace : 0;
  size_t visited = 0;
  for (auto it = demLru_.begin(); it != demLru_.end() && demBytes_ > budget && visited < evictable;
       visited++) {
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
    std::vector<float> r(static_cast<size_t>(kDemSize) * kDemSize);
    for (int j = 0; j < kDemSize; j++)
      for (int i = 0; i < kDemSize; i++)
        r[j * kDemSize + i] = static_cast<float>(sampleDem(
            heights.data(), img.width, (i + 0.5) / kDemSize, (j + 0.5) / kDemSize));
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

// ---- imagery -------------------------------------------------------------------

void Engine::onImageryData(int z, int x, int y, std::vector<uint8_t> rgba) {
  onImageryLevels(z, x, y, std::move(rgba), kImagerySize, 1, imgGeneration_.load());
}

void Engine::onImageryLevels(int z, int x, int y, std::vector<uint8_t> chain, int size, int levels,
                             uint32_t generation) {
  if (generation != imgGeneration_.load()) return;  // a texture of a style since replaced
  if (size < 1 || levels < 1 || chain.size() != mipChainBytes(size, levels)) {
    onImageryFailed(z, x, y);
    return;
  }
  {
    std::lock_guard<std::mutex> lock(imgMutex_);
    if (generation != imgGeneration_.load()) return;
    const uint64_t k = demKey64({z, x, y});
    const bool requested = imgPending_.erase(k) > 0;
    imgFailedAt_.erase(k);
    auto& e = imagery_[k];
    e.pending = std::make_shared<const std::vector<uint8_t>>(std::move(chain));
    e.size = size;
    e.levels = levels;
    e.wanted = e.wanted || requested || e.slot >= 0;
    e.arrived = ++imgArrivals_;
    if (!e.wanted) {
      // Bound the unrequested siblings waiting CPU-side: drop the oldest.
      std::vector<std::pair<uint64_t, uint64_t>> unwanted;
      for (const auto& [key, en] : imagery_)
        if (!en.wanted && en.slot < 0 && en.pending) unwanted.push_back({en.arrived, key});
      if (unwanted.size() > kMaxUnwantedImagery) {
        std::sort(unwanted.begin(), unwanted.end());
        for (size_t i = 0; i + kMaxUnwantedImagery < unwanted.size(); i++) imagery_.erase(unwanted[i].second);
      }
    }
  }
  if (repaint_) repaint_();
}

void Engine::resetImageryLocked(int slots) {
  imgGeneration_++;
  imagery_.clear();
  imgPending_.clear();
  imgFailedAt_.clear();
  imgSlotCount_ = std::max(1, slots);
  freeImgSlots_.clear();
  for (int i = imgSlotCount_ - 1; i >= 0; i--) freeImgSlots_.push_back(i);
  resetTileImagery_ = true;
}

void Engine::setDrape(bool on, int slots) {
  {
    std::lock_guard<std::mutex> lock(imgMutex_);
    const bool changed = drape_.load() != on || slots != imgSlotCount_;
    drape_ = on;
    if (changed) resetImageryLocked(slots);
  }
  if (repaint_) repaint_();
}

void Engine::resetImagery() {
  {
    std::lock_guard<std::mutex> lock(imgMutex_);
    resetImageryLocked(imgSlotCount_);
  }
  if (repaint_) repaint_();
}

void Engine::onImageryFailed(int z, int x, int y) {
  std::lock_guard<std::mutex> lock(imgMutex_);
  const uint64_t k = demKey64({z, x, y});
  imgPending_.erase(k);
  imgFailedAt_[k] = clockMs_;
}

// ---- scene inputs -------------------------------------------------------------------

void Engine::setLabels(std::vector<LabelData> labels) {
  std::lock_guard<std::mutex> lock(sceneMutex_);
  std::unordered_map<int, LabelEntry> old;
  for (auto& e : labels_) old[e.data.id] = e;
  labels_.clear();
  labels_.reserve(labels.size());
  for (auto& d : labels) {
    LabelEntry e;
    auto it = old.find(d.id);
    if (it != old.end() && it->second.data.mercX == d.mercX && it->second.data.mercY == d.mercY) {
      e.h = it->second.h;
      e.hGen = it->second.hGen;
    }
    e.data = d;
    labels_.push_back(e);
  }
  if (repaint_) repaint_();
}

void Engine::setPolyline(int id, std::vector<Pt> mercPoints, const LineStyle& style) {
  std::lock_guard<std::mutex> lock(sceneMutex_);
  auto& p = polylines_[id];
  p.points = std::move(mercPoints);
  p.style = style;
  p.liftedDemGen = UINT32_MAX;  // re-lift
  p.liftedAt = -1e300;
  if (repaint_) repaint_();
}

void Engine::removePolyline(int id) {
  std::lock_guard<std::mutex> lock(sceneMutex_);
  polylines_.erase(id);
  if (repaint_) repaint_();
}

void Engine::setLabelInsets(double topPx, double bottomPx) {
  std::lock_guard<std::mutex> lock(sceneMutex_);
  labelTopPx_ = std::max(0.0, topPx);
  labelBottomPx_ = std::max(0.0, bottomPx);
}

void Engine::setPuck(bool visible, double mercX, double mercY) {
  std::lock_guard<std::mutex> lock(sceneMutex_);
  puckVisible_ = visible;
  puckX_ = mercX;
  puckY_ = mercY;
  if (repaint_) repaint_();
}

void Engine::setMasks(std::vector<std::vector<Pt>> water, std::vector<std::vector<Pt>> glacier) {
  auto m = std::make_shared<MaskSet>();
  for (auto& r : water) {
    if (r.size() < 3) continue;
    m->waterBox.push_back(ringBox(r));
    m->water.push_back(std::move(r));
  }
  for (auto& r : glacier) {
    if (r.size() < 3) continue;
    m->glacierBox.push_back(ringBox(r));
    m->glacier.push_back(std::move(r));
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    masks_ = std::move(m);
  }
  maskGen_++;
  if (repaint_) repaint_();
}

void Engine::trimMemory() {
  {
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
  }
  trimMeshes_ = true;  // render-thread state: the next frame drops what it doesn't draw
}

void Engine::reset() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    dems_.clear();
    demLru_.clear();
    demBytes_ = 0;
    pending_.clear();
    failedAt_.clear();
    demPins_.clear();
  }
  resetMeshes_ = true;
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
  {
    std::lock_guard<std::mutex> lock(mutex_);
    s.demCount = static_cast<int>(dems_.size());
    s.demBytes = demBytes_;
    s.inFlight = static_cast<int>(pending_.size());
  }
  s.requested = requested_.load();
  s.failed = failed_.load();
  return s;
}

// ---- bakes (worker thread) --------------------------------------------------------------

float Engine::morphOf(const Mesh& m, double now) const {
  return static_cast<float>(morphFactor(now - m.morphStart));
}

Engine::BakeResult Engine::runBake(const BakeJob& job) {
  const TileId& t = job.tile;
  const DemWindow& w = job.window;
  DemNeighborhood nb;
  nb.size = kDemSize;
  nb.center = job.dems[4]->heights.data();
  for (int i = 0; i < 9; i++) nb.around[i] = job.dems[i] ? job.dems[i]->heights.data() : nullptr;
  auto sampler = [&](double u, double v) {
    return sampleMosaic(nb, w.offsetX + u * w.scale, w.offsetY + v * w.scale);
  };
  const int N = job.grid;
  BakeResult r;
  r.tile = t;
  r.demZoom = job.demZoom;
  r.maskGen = job.maskGen;
  r.fromFlat = job.fromFlat;
  r.hTo = bakeHeights(N, sampler);
  const double tileMeters = tileSizeMeters(t.z, tileCenterLat(t));
  const std::vector<float> slopes = bakeSlopes(N, sampler, tileMeters / N);
  r.hFrom = job.hFrom.empty() ? r.hTo : job.hFrom;
  float mn = r.hTo[0], mx = r.hTo[0];
  for (size_t k = 0; k < r.hTo.size(); k++) {
    mn = std::min({mn, r.hTo[k], r.hFrom[k]});
    mx = std::max({mx, r.hTo[k], r.hFrom[k]});
  }
  r.minH = mn;
  r.maxH = mx;
  r.attributes = std::make_shared<const std::vector<float>>(packAttributes(N, r.hFrom, r.hTo, slopes));

  // Detail texture: per-pixel slopes (sharper relief than the 33² mesh) and masks.
  const int S = kDetailSize;
  auto detail = std::make_shared<std::vector<uint8_t>>(static_cast<size_t>(S) * S * 4, 0);
  const double d = 1.0 / S;
  const double inv = 1.0 / (2.0 * tileMeters / S);
  for (int j = 0; j < S; j++) {
    for (int i = 0; i < S; i++) {
      const double u = (i + 0.5) / S, v = (j + 0.5) / S;
      const double sx = (sampler(u + d, v) - sampler(u - d, v)) * inv;
      const double sy = (sampler(u, v + d) - sampler(u, v - d)) * inv;
      uint8_t* p = detail->data() + (static_cast<size_t>(j) * S + i) * 4;
      p[0] = enc(sx / kSlopeRange * 0.5 + 0.5);
      p[1] = enc(sy / kSlopeRange * 0.5 + 0.5);
    }
  }
  if (job.masks) {
    const double n = std::pow(2.0, t.z);
    const double tx0 = t.x / n, ty0 = t.y / n, tx1 = (t.x + 1) / n, ty1 = (t.y + 1) / n;
    auto raster = [&](const std::vector<std::vector<Pt>>& rings,
                      const std::vector<std::array<double, 4>>& boxes, int channel) {
      std::vector<std::vector<Pt>> local;
      for (size_t k = 0; k < rings.size(); k++) {
        const auto& b = boxes[k];
        if (b[2] < tx0 || b[0] > tx1 || b[3] < ty0 || b[1] > ty1) continue;
        std::vector<Pt> r2;
        r2.reserve(rings[k].size());
        for (const auto& p : rings[k]) r2.push_back({p[0] * n - t.x, p[1] * n - t.y});
        local.push_back(std::move(r2));
      }
      if (local.empty()) return;
      const auto m = rasterizePolygons(local, S);
      for (size_t k = 0; k < m.size(); k++) (*detail)[k * 4 + channel] = m[k];
    };
    raster(job.masks->water, job.masks->waterBox, 2);
    raster(job.masks->glacier, job.masks->glacierBox, 3);
  }
  r.detail = std::move(detail);
  return r;
}

void Engine::workerLoop() {
  for (;;) {
    BakeJob job;
    {
      std::unique_lock<std::mutex> lock(jobMutex_);
      jobCv_.wait(lock, [this] { return stop_ || !jobs_.empty(); });
      if (stop_) return;
      job = std::move(jobs_.front());
      jobs_.pop_front();
      busy_++;
    }
    BakeResult r = runBake(job);
    {
      std::lock_guard<std::mutex> lock(jobMutex_);
      results_.push_back(std::move(r));
      busy_--;
    }
    if (repaint_) repaint_();
  }
}

void Engine::drainBakes(int timeoutMs) {
  const double until = nowCpuMs() + timeoutMs;
  while (nowCpuMs() < until) {
    {
      std::lock_guard<std::mutex> lock(jobMutex_);
      if (jobs_.empty() && busy_.load() == 0) return;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

bool Engine::scheduleBake(const TileId& t, int demZoom, double now) {
  const uint64_t key = meshKeyOf(t);
  if (inProgress_.count(key)) return false;
  BakeJob job;
  job.tile = t;
  job.grid = meshGrid_;
  job.demZoom = demZoom;
  job.maskGen = maskGen_.load();
  job.window = demWindowAt(t, demZoom);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        std::shared_ptr<const Dem> d;
        if (dx == 0 && dy == 0) {
          d = demLocked(job.window.dem);
        } else if (auto nb = demNeighbor(job.window.dem, dx, dy)) {
          d = demLocked(*nb);
        }
        job.dems[(dy + 1) * 3 + (dx + 1)] = d;
      }
    }
    job.masks = masks_;
  }
  if (!job.dems[4]) return false;
  // What is on screen there now: this tile's current surface, else the nearest ancestor's.
  auto existing = meshes_.find(key);
  if (existing != meshes_.end()) {
    const Mesh& old = existing->second;
    const float m = morphOf(old, now);
    if (old.fromFlat && m > 0.5f) {
      job.fromFlat = true;
    } else {
      job.hFrom.resize(old.hTo.size());
      for (size_t k = 0; k < job.hFrom.size(); k++)
        job.hFrom[k] = old.fromFlat ? old.hTo[k] : old.hTo[k] + (old.hFrom[k] - old.hTo[k]) * m;
    }
  } else {
    bool found = false;
    for (int up = 1; up <= 4 && t.z - up >= 0 && !found; up++) {
      const TileId a{t.z - up, t.x >> up, t.y >> up, t.wrap};
      auto it = meshes_.find(meshKeyOf(a));
      if (it == meshes_.end()) continue;
      if (up == 1) {
        job.hFrom = parentSurfaceForChild(meshGrid_, it->second.hTo, t.x & 1, t.y & 1);
      } else {
        const double k = std::pow(2.0, up);
        const double ox = (t.x - a.x * k) / k, oy = (t.y - a.y * k) / k;
        const auto& ah = it->second.hTo;
        const int N = meshGrid_;
        job.hFrom = bakeHeights(N, [&](double u, double v) { return surfaceAt(N, ah, ox + u / k, oy + v / k); });
      }
      found = true;
    }
    if (!found) job.fromFlat = true;
  }
  inProgress_.insert(key);
  {
    std::lock_guard<std::mutex> lock(jobMutex_);
    jobs_.push_back(std::move(job));
  }
  jobCv_.notify_one();
  return true;
}

void Engine::installResults(double now) {
  std::vector<BakeResult> done;
  {
    std::lock_guard<std::mutex> lock(jobMutex_);
    done.swap(results_);
  }
  for (auto& r : done) {
    const uint64_t key = meshKeyOf(r.tile);
    inProgress_.erase(key);
    auto existing = meshes_.find(key);
    if (existing != meshes_.end() && existing->second.demZoom > r.demZoom) continue;
    Mesh mesh;
    mesh.demZoom = r.demZoom;
    mesh.maskGen = r.maskGen;
    mesh.minH = r.minH;
    mesh.maxH = r.maxH;
    mesh.attributes = std::move(r.attributes);
    mesh.detail = std::move(r.detail);
    mesh.hTo = std::move(r.hTo);
    mesh.hFrom = std::move(r.hFrom);
    mesh.fromFlat = r.fromFlat;
    mesh.version = ++versionCounter_;
    // Same heights (a mask refresh): no morph to run.
    const bool sameHeights = existing != meshes_.end() && existing->second.demZoom == r.demZoom &&
                             !existing->second.fromFlat;
    mesh.morphStart = sameHeights ? -1e300 : now;
    stats_.meshBakes++;
    if (!sameHeights) {
      // How far the surface visibly moves: peak |hTo − hFrom| (flat: from hRef).
      double d = 0;
      for (size_t k = 0; k < mesh.hTo.size() && k < mesh.hFrom.size(); k++)
        d = std::max(d, static_cast<double>(std::abs(mesh.hTo[k] - (mesh.fromFlat ? static_cast<float>(hRef_.value_or(mesh.hTo[k])) : mesh.hFrom[k]))));
      if (d > kVisibleMorphM) {
        stats_.morphs++;
        stats_.maxMorphM = std::max(stats_.maxMorphM, d);
      }
    }
    if (existing != meshes_.end()) {
      mesh.lru = existing->second.lru;
      meshLru_.splice(meshLru_.end(), meshLru_, mesh.lru);
      existing->second = std::move(mesh);
    } else {
      meshLru_.push_back(key);
      mesh.lru = std::prev(meshLru_.end());
      meshes_.emplace(key, std::move(mesh));
    }
    stats_.bakedThisFrame++;
  }
}

// ---- inherited placeholder meshes (2.2.1) -------------------------------------------

bool Engine::inheritMesh(const TileId& t, double /*now*/) {
  for (int up = 1; up <= t.z; up++) {
    const TileId a{t.z - up, t.x >> up, t.y >> up, t.wrap};
    auto it = meshes_.find(meshKeyOf(a));
    if (it == meshes_.end() || it->second.hTo.empty()) continue;
    const int N = meshGrid_;
    if (it->second.hTo.size() != static_cast<size_t>((N + 1) * (N + 1))) continue;
    const double k = std::pow(2.0, up);
    const double ox = (t.x - a.x * k) / k, oy = (t.y - a.y * k) / k;
    const std::vector<float>& ah = it->second.hTo;
    auto sampler = [&](double u, double v) { return surfaceAt(N, ah, ox + u / k, oy + v / k); };
    Mesh mesh;
    mesh.demZoom = -1;  // stale: the real bake replaces it, morphing from these heights
    mesh.maskGen = maskGen_.load();
    mesh.hTo = bakeHeights(N, sampler);
    mesh.hFrom = mesh.hTo;
    const double tileMeters = tileSizeMeters(t.z, tileCenterLat(t));
    const std::vector<float> slopes = bakeSlopes(N, sampler, tileMeters / N);
    mesh.attributes = std::make_shared<const std::vector<float>>(packAttributes(N, mesh.hFrom, mesh.hTo, slopes));
    float mn = mesh.hTo.empty() ? 0.f : mesh.hTo[0], mx = mn;
    for (float h : mesh.hTo) {
      mn = std::min(mn, h);
      mx = std::max(mx, h);
    }
    mesh.minH = mn;
    mesh.maxH = mx;
    mesh.fromFlat = false;
    mesh.morphStart = -1e300;
    mesh.version = ++versionCounter_;
    const uint64_t key = meshKeyOf(t);
    meshLru_.push_back(key);
    mesh.lru = std::prev(meshLru_.end());
    meshes_.emplace(key, std::move(mesh));
    return true;
  }
  return false;
}

// ---- frame -----------------------------------------------------------------------

FrameOutput Engine::frame(const FrameInput& in) {
  const double cpuStart = nowCpuMs();
  FrameOutput out;
  const double now = in.timeMs;
  const double dt = lastTimeMs_ < 0 ? 0 : now - lastTimeMs_;
  lastTimeMs_ = now;
  clockMs_ = now;
  frameNo_++;
  stats_.bakedThisFrame = 0;

  out.look = look();
  out.ramp = static_cast<float>(pitchRamp(in.pitchDeg));
  if (out.ramp <= 0 || in.width <= 0 || in.height <= 0) {
    stats_.tilesDrawn = 0;
    return out;
  }
  out.active = true;
  out.width = static_cast<float>(in.width);
  out.height = static_cast<float>(in.height);
  const double exag = out.look.exaggeration;
  out.exaggeration = static_cast<float>(exag);
  const bool drape = drape_.load();
  const bool imageryMode = drape || out.look.imagery > 0.5f;
  out.drape = drape;
  if (resetTileImagery_.exchange(false)) tileImagery_.clear();

  if (resetMeshes_.exchange(false)) {
    meshes_.clear();
    meshLru_.clear();
    meshPins_.clear();
    hRef_.reset();
  }
  installResults(now);

  FrameCamera cam{in.P, in.width, in.height, in.fovRad, in.zoom, in.lat};
  const double ws = worldSize(in.zoom);
  const int refZoom = std::min(kDemMaxZoom, static_cast<int>(std::floor(in.zoom)) + 1);
  const auto invP = invert(in.P);

  const bool legacy = (out.look.debugFlags & kDebugLegacy) != 0;
  {
    const double cam[5] = {in.lat, in.lng, in.zoom, in.bearingDeg, in.pitchDeg};
    bool moved = false;
    for (int i = 0; i < 5; i++) moved = moved || std::abs(cam[i] - lastCam_[i]) > 1e-7;
    if (moved) lastMoveMs_ = now;
    std::copy(cam, cam + 5, lastCam_);
  }
  // Reference height (2.2.1): the ground under the map centre — the tilt
  // pivot, so tilting never moves it — raised only when the nearest visible
  // ground (under the bottom edge) would come too close to the camera. The
  // 2.2.0 rule (the max under the bottom edge) swept across ridges as the
  // view tilted and heaved the whole terrain ("mountains grow and shrink").
  bool hRefSettling = false;
  if (invP) {
    std::vector<std::optional<double>> samples;
    for (const auto& ndc : {std::array<double, 2>{-0.9, -0.98}, std::array<double, 2>{0, -0.98},
                            std::array<double, 2>{0.9, -0.98}}) {
      auto g = groundAtNdc(*invP, ndc[0], ndc[1]);
      if (!g) continue;
      samples.push_back(heightAt(g->first / ws, g->second / ws, refZoom));
    }
    bool any = false;
    for (auto& s : samples) any = any || s.has_value();
    const auto center = heightAt(lngToMercX(in.lng), latToMercY(in.lat), refZoom);
    if (any || center) {
      const std::optional<double> nearMax =
          any ? std::optional<double>(referenceHeight(samples)) : std::nullopt;
      const auto eye = eyeFromProjection(in.P);
      const double eyeAlt = eye ? (*eye)[2] : 1e9;
      const double scale = exag * pitchRamp(in.pitchDeg);
      const double desired = stableReferenceHeight(center, nearMax, eyeAlt, scale);
      const double prev = hRef_.value_or(desired);
      if (legacy) {
        hRef_ = smoothToward(hRef_, desired, dt, 300, 0.5);
      } else if (hRef_ && now - lastMoveMs_ < kRefSettleMs) {
        // Round 3: held while the camera moves (the terrain no longer rides
        // the ground under the centre during a pan); only the camera-clearance
        // guard may raise it. It settles on the centre once the camera rests.
        const double guard = stableReferenceHeight(-1e9, nearMax, eyeAlt, scale);
        hRef_ = smoothToward(hRef_, std::max(*hRef_, guard), dt, 150, 0.5);
      } else {
        hRef_ = smoothToward(hRef_, desired, dt, 700, 0.5);
      }
      hRefSettling = *hRef_ != desired;
      stats_.hRefTravelM += std::abs(*hRef_ - prev);
    }
  }
  const double hRef = hRef_.value_or(0.0);
  out.hRef = static_cast<float>(hRef);
  const double heightScale = exag * out.ramp;

  // LOD selection.
  LodOptions opts;
  opts.fogEndCtc = out.look.fogEndCtc;
  if (!(out.look.debugFlags & kDebugLegacy)) {
    // Round 3: coarser toward the fog — the far band costs little and is hazed anyway.
    opts.fogStartCtc = out.look.fogStartCtc;
    opts.fogLodBoost = kFogLodBoost;
  }
  // A finer mesh (and so drape) near the camera than the 2.2.0 default.
  opts.maxErrorPx = kLodMaxErrorPx;
  if (out.look.debugFlags & 8) opts.maxErrorPx = kLodMaxErrorPx * 2;
  opts.hRef = hRef;
  opts.heightScale = heightScale;
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
  // The 360° base ring: pinned coarse DEMs, meshes and drapes in every
  // direction, so a tile that turns into view always has an ancestor
  // surface and texture (never flat, never white) — and prefetch on rotation.
  const std::vector<TileId> ring =
      baseRing(lngToMercX(in.lng), latToMercY(in.lat),
               baseRingZoom(in.zoom, out.look.fogEndCtc * sel.ctc), kBaseRingRadius);
  out.ctc = static_cast<float>(sel.ctc);
  out.farW = static_cast<float>(out.look.fogEndCtc * sel.ctc * 1.6);
  out.contourBase = baseLevelIndex(in.zoom);
  const Vec3 light = lightDirection(in.bearingDeg);
  out.light[0] = static_cast<float>(light[0]);
  out.light[1] = static_cast<float>(light[1]);
  out.light[2] = static_cast<float>(light[2]);

  // Bakes (async; nearest first) and DEM pins.
  std::unordered_set<uint64_t> pins;
  bool bakesPending = false;
  const uint32_t maskGen = maskGen_.load();
  int queued;
  {
    std::lock_guard<std::mutex> lock(jobMutex_);
    queued = static_cast<int>(jobs_.size());
  }
  std::vector<TileId> bakeOrder;
  bakeOrder.reserve(ring.size() + sel.tiles.size());
  for (const auto& t : ring) bakeOrder.push_back(t);
  for (const auto& s : sel.tiles) bakeOrder.push_back(s.tile);
  for (const auto& tile : bakeOrder) {
    const struct {
      TileId tile;
    } s{tile};
    std::optional<int> best;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      best = bestLoadedDemZoom(s.tile, [this](const DemId& d) { return demLoadedLocked(d); });
      if (best) {
        const DemWindow w = demWindowAt(s.tile, *best);
        pins.insert(demKey64(w.dem));
        touchDemLocked(demKey64(w.dem));
      }
      // 2.2.1: only the DEM each tile bakes from is pinned (plus the base
      // ring's). 2.2.0 also pinned every loaded ancestor; at a steep tilt the
      // pinned set outgrew the budget, every fresh DEM was evicted on arrival
      // and re-requested (~400/s at rest), and the height lookups behind the
      // reference height and the pins flickered.
    }
    if (!best) continue;
    auto it = meshes_.find(meshKeyOf(s.tile));
    const bool stale = it == meshes_.end() || it->second.demZoom < *best ||
                       (it->second.maskGen != maskGen && !imageryMode);
    if (!stale) continue;
    if (!legacy) {
      // Round 3: no intermediate coarse bakes. While the tile's own DEM is on
      // its way, keep what is drawn (its mesh, or a placeholder from an
      // ancestor) instead of baking from a coarser DEM and morphing twice —
      // coarse DEMs flatten peaks by hundreds of metres ("peaks regrow").
      const DemId own = demWindow(s.tile).dem;
      bool ownPending;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        ownPending = *best < own.z && pending_.count(demKey64(own)) > 0;
      }
      if (ownPending) {
        bool hasFallback = it != meshes_.end();
        for (int up = 1; up <= s.tile.z && !hasFallback; up++)
          hasFallback = meshes_.count(meshKeyOf({s.tile.z - up, s.tile.x >> up, s.tile.y >> up, s.tile.wrap})) > 0;
        if (hasFallback) {
          bakesPending = true;
          continue;
        }
      }
    }
    if (inProgress_.count(meshKeyOf(s.tile))) {
      bakesPending = true;
      continue;
    }
    if (queued < kMaxBakeJobs) {
      if (scheduleBake(s.tile, *best, now)) queued++;
    } else {
      bakesPending = true;
    }
  }
  bakesPending = bakesPending || !inProgress_.empty();
  {
    std::lock_guard<std::mutex> lock(mutex_);
    // Pin everything the request planner still wants (and the ring), so a
    // DEM it fetched is never evicted while wanted and then fetched again.
    std::vector<TileId> wantedFor;
    wantedFor.reserve(bakeOrder.size());
    for (const auto& t : bakeOrder) wantedFor.push_back(t);
    for (const auto& d : wantedDems(wantedFor, in.bearingDeg)) {
      const uint64_t key = demKey64(d);
      if (dems_.count(key)) pins.insert(key);
    }
    demPins_ = std::move(pins);
    evictDemsLocked();
  }

  // Draw list with ancestor substitution (nothing overlaps, nothing gaps).
  std::vector<TileId> draw;
  draw.reserve(sel.tiles.size());
  std::unordered_set<std::string> substituted;
  int inherited = 0;
  for (const auto& s : sel.tiles) {
    if (meshes_.count(meshKeyOf(s.tile))) {
      draw.push_back(s.tile);
      continue;
    }
    // 2.2.1: a placeholder surface sampled from the nearest ancestor's, so
    // only this tile is coarse until its own bake morphs in (substituting the
    // ancestor would redraw its whole area coarse, pruning loaded children).
    if (inherited < kMaxInheritPerFrame && inheritMesh(s.tile, now)) {
      inherited++;
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
    if (!found) draw.push_back(s.tile);
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

  // Imagery: uploads for newly arrived tiles, slot pins, requests.
  std::unordered_set<uint64_t> imgUsed;
  bool imageryFading = false;
  auto imageryBest = [&](const TileId& t, int& slotOut, std::array<float, 3>& win) -> uint64_t {
    const int zOwn = std::min(t.z, kImageryMaxZoom);
    for (int z = zOwn; z >= 0; z--) {
      const DemWindow w = demWindowAt(t, z);
      const uint64_t key = demKey64(w.dem);
      auto it = imagery_.find(key);
      if (it != imagery_.end() && it->second.slot >= 0) {
        slotOut = it->second.slot;
        win = {static_cast<float>(w.offsetX), static_cast<float>(w.offsetY),
               static_cast<float>(w.scale)};
        it->second.lastFrame = frameNo_;
        imgUsed.insert(key);
        return key;
      }
    }
    slotOut = -1;
    return 0;
  };
  if (imageryMode) {
    std::lock_guard<std::mutex> lock(imgMutex_);
    // The base ring's drapes never age out (the fallback in every direction).
    for (const auto& t : ring) {
      auto it = imagery_.find(demKey64({t.z, t.x, t.y}));
      if (it == imagery_.end()) continue;
      it->second.lastFrame = frameNo_;
      it->second.wanted = true;
    }
    // Uploads (bounded per frame), evicting the least recently drawn slots.
    int uploads = 0;
    std::vector<uint64_t> ready;
    for (auto& [key, e] : imagery_)
      if (e.pending && e.wanted) ready.push_back(key);
    for (uint64_t key : ready) {
      if (uploads >= kImageryUploadsPerFrame) break;
      auto found = imagery_.find(key);
      if (found == imagery_.end()) continue;
      if (freeImgSlots_.empty()) {
        uint64_t victim = 0;
        uint64_t oldest = UINT64_MAX;
        for (auto& [k2, e2] : imagery_) {
          if (e2.slot >= 0 && e2.lastFrame + 2 < frameNo_ && e2.lastFrame < oldest) {
            oldest = e2.lastFrame;
            victim = k2;
          }
        }
        if (oldest == UINT64_MAX) break;
        freeImgSlots_.push_back(imagery_[victim].slot);
        imagery_.erase(victim);
        found = imagery_.find(key);
        if (found == imagery_.end()) continue;
      }
      ImgEntry& e = found->second;
      e.slot = freeImgSlots_.back();
      freeImgSlots_.pop_back();
      ImageryUpload up;
      up.slot = e.slot;
      up.size = e.size;
      up.levels = e.levels;
      up.pixels = e.pending;
      out.imageryUploads.push_back(std::move(up));
      e.pending.reset();
      e.lastFrame = frameNo_;
      uploads++;
    }
  }

  bool morphing = false;
  meshPins_.clear();
  for (const auto& t : ring) meshPins_.insert(meshKeyOf(t));
  int flat = 0;
  {
    std::unique_lock<std::mutex> imgLock(imgMutex_, std::defer_lock);
    if (imageryMode) imgLock.lock();
    for (const auto& t : draw) {
      const TileBounds b = tileBoundsPx(t, in.zoom);
      const Mat4 m =
          multiply(in.P, multiply(translation(b.minX, b.minY, 0), scaling(b.size, b.size, 1)));
      DrawTile d;
      d.key = meshKeyOf(t);
      for (int i = 0; i < 16; i++) d.matrix[i] = static_cast<float>(m[i]);
      d.skirtDepth = static_cast<float>(skirtDepth(tileSizeMeters(t.z, tileCenterLat(t))));
      auto it = meshes_.find(d.key);
      if (it != meshes_.end()) {
        const Mesh& mesh = it->second;
        d.version = mesh.version;
        d.attributes = mesh.attributes;
        d.detail = mesh.detail;
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
      if (imageryMode) {
        int slot = -1;
        std::array<float, 3> win{0, 0, 1};
        const uint64_t key = imageryBest(t, slot, win);
        auto& ti = tileImagery_[d.key];
        if (key != ti.key) {
          ti.prevKey = ti.key;
          ti.key = key;
          ti.since = ti.prevKey ? now : -1e300;
        }
        d.imgB = slot;
        for (int i = 0; i < 3; i++) d.winB[i] = win[i];
        const double fade = (now - ti.since) / kImageryFadeMs;
        if (ti.prevKey && fade < 1) {
          auto pit = imagery_.find(ti.prevKey);
          if (pit != imagery_.end() && pit->second.slot >= 0) {
            // The previous window: recompute for the prev key's zoom.
            const int pz = static_cast<int>(ti.prevKey >> 58);
            const DemWindow pw = demWindowAt(t, pz);
            d.imgA = pit->second.slot;
            d.winA[0] = static_cast<float>(pw.offsetX);
            d.winA[1] = static_cast<float>(pw.offsetY);
            d.winA[2] = static_cast<float>(pw.scale);
            d.imgBlend = static_cast<float>(smoothstep(0, 1, fade));
            pit->second.lastFrame = frameNo_;
            imageryFading = true;
          } else {
            d.imgBlend = 1;
          }
        } else {
          d.imgBlend = 1;
        }
      }
      out.tiles.push_back(std::move(d));
    }
  }
  const size_t meshBudget = trimMeshes_.exchange(false) ? 0 : kMeshBudget;
  for (auto it = meshLru_.begin(); it != meshLru_.end() && meshes_.size() > meshBudget;) {
    if (meshPins_.count(*it) || inProgress_.count(*it)) {
      ++it;
      continue;
    }
    meshes_.erase(*it);
    tileImagery_.erase(*it);
    it = meshLru_.erase(it);
  }

  // DEM requests.
  std::vector<TileId> visible;
  visible.reserve(ring.size() + sel.tiles.size());
  for (const auto& t : ring) visible.push_back(t);
  for (const auto& s : sel.tiles) visible.push_back(s.tile);
  {
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
      if (demRequest_) demRequest_(d.z, d.x, d.y);
    }
  }
  // Imagery requests: a coarse ancestor first, then the tile's own, nearest first.
  if (imageryMode && imageryRequest_) {
    std::vector<DemId> want;
    {
      std::lock_guard<std::mutex> lock(imgMutex_);
      int room = kMaxInFlight - static_cast<int>(imgPending_.size());
      std::unordered_set<uint64_t> seen;
      // Each visible tile, nearest first (a coarse ancestor, then its own),
      // then the base ring's own drapes — coarse renders are slow, so they
      // never hold up what is on screen.
      std::vector<std::pair<TileId, bool>> order;
      order.reserve(visible.size());
      for (size_t vi = ring.size(); vi < visible.size(); vi++) order.push_back({visible[vi], false});
      for (const auto& t : ring) order.push_back({t, true});
      for (const auto& [t, ringTile] : order) {
        if (room <= 0 || static_cast<int>(want.size()) >= kRequestsPerFrame) break;
        const int zOwn = std::min(t.z, kImageryMaxZoom);
        for (int z : {ringTile ? zOwn : std::max(0, zOwn - 3), zOwn}) {
          const DemId id = demWindowAt(t, z).dem;
          const uint64_t k = demKey64(id);
          if (!seen.insert(k).second) continue;
          auto have = imagery_.find(k);
          if (have != imagery_.end()) {
            have->second.wanted = true;  // a block sibling that arrived earlier: upload it
            continue;
          }
          if (imgPending_.count(k)) continue;
          auto f = imgFailedAt_.find(k);
          if (f != imgFailedAt_.end() && now - f->second < kRetryMs) continue;
          imgPending_.insert(k);
          want.push_back(id);
          room--;
          if (room <= 0 || static_cast<int>(want.size()) >= kRequestsPerFrame) break;
        }
      }
    }
    for (const auto& d : want) imageryRequest_(d.z, d.x, d.y);
  }

  // Sky rays and visibility.
  if (invP && sel.eye) {
    const double ppm = pixelsPerMeter(in.lat, in.zoom);
    const double corners[3][2] = {{-1, -1}, {3, -1}, {-1, 3}};
    const Vec3& e = *sel.eye;
    for (int i = 0; i < 3; i++) {
      const Vec4 v = transform(*invP, {corners[i][0], corners[i][1], 1, 1});
      out.skyRays[i][0] = static_cast<float>(v[0] - e[0] * v[3]);
      out.skyRays[i][1] = static_cast<float>(v[1] - e[1] * v[3]);
      out.skyRays[i][2] = static_cast<float>((v[2] - e[2] * v[3]) * ppm);
      out.skyRays[i][3] = static_cast<float>(v[3]);
    }
    out.skyVisible = false;
    for (double x : {-1.0, 1.0}) {
      const Vec4 v = transform(*invP, {x, 1, 1, 1});
      if (std::abs(v[3]) < 1e-12) continue;
      const double dx = v[0] / v[3] - e[0], dy = v[1] / v[3] - e[1];
      const double dz = (v[2] / v[3] - e[2]) * ppm;
      if (dz / std::hypot(dx, dy, dz) > -0.06) out.skyVisible = true;
    }
  }

  // Wrap a mercator x to the world copy nearest the view centre (world px).
  const double cx = lngToMercX(in.lng) * ws;
  auto worldX = [&](double mx) {
    double x = mx * ws;
    const double k = std::round((cx - x) / ws);
    return x + k * ws;
  };
  const uint32_t demGen = demGeneration_.load();
  const double ppm = pixelsPerMeter(in.lat, in.zoom);

  // 3D pin labels.
  bool labelsFading = false;
  {
    std::lock_guard<std::mutex> lock(sceneMutex_);
    std::vector<LabelInput> inputs;
    inputs.reserve(labels_.size());
    std::unordered_map<int, const LabelData*> byId;
    for (auto& e : labels_) {
      if (e.hGen != demGen) {
        const bool first = e.hGen == UINT32_MAX;
        if (auto h = heightAt(e.data.mercX, e.data.mercY, refZoom)) {
          e.hTarget = *h;
          if (first || legacy) e.h = *h;
        }
        e.hGen = demGen;
      }
      // Round 3: a pin glides to a refined height instead of jumping.
      if (e.h != e.hTarget) {
        e.h = smoothToward(e.h, e.hTarget, dt, 250, 0.5);
        labelsFading = true;
      }
      LabelInput li;
      li.id = e.data.id;
      li.x = worldX(e.data.mercX);
      li.y = e.data.mercY * ws;
      li.h = e.h;
      li.kind = e.data.kind;
      li.priority = e.data.priority;
      li.w = e.data.w;
      li.ph = e.data.h;
      inputs.push_back(li);
      byId[e.data.id] = &e.data;
    }
    PlaceOptions po;
    po.P = in.P;
    po.width = in.width;
    po.height = in.height;
    po.ctc = sel.ctc;
    po.hRef = hRef;
    po.heightScale = heightScale;
    po.topPx = labelTopPx_;
    po.bottomPx = labelBottomPx_;
    po.dtMs = dt;
    po.nowMs = now;
    po.fadeFromCtc = out.look.fogEndCtc * 0.55;
    po.fadeToCtc = out.look.fogEndCtc * 0.8;
    const auto eye = sel.eye;
    auto terrainZ = [&](double x, double y) -> std::optional<double> {
      auto h = heightAt(x / ws, y / ws, refZoom);
      if (!h) return std::nullopt;
      return (*h - hRef) * heightScale;
    };
    if (eye) {
      po.occluded = [&](const LabelInput& l) {
        const Vec3 anchor{l.x, l.y, (l.h - hRef) * heightScale};
        return occludedByTerrain(*eye, anchor, terrainZ);
      };
    }
    (void)ppm;
    const auto placed = placeLabels(inputs, labelStates_, po);
    for (const auto& p : placed) {
      auto it = byId.find(p.id);
      if (it == byId.end()) continue;
      const LabelData& ld = *it->second;
      LabelDraw dr;
      dr.id = p.id;
      const float w = ld.w * static_cast<float>(p.scale), h = ld.h * static_cast<float>(p.scale);
      dr.x0 = static_cast<float>(p.cx) - w / 2;
      dr.x1 = static_cast<float>(p.cx) + w / 2;
      dr.y0 = static_cast<float>(p.cy) - h / 2;
      dr.y1 = static_cast<float>(p.cy) + h / 2;
      dr.gx = static_cast<float>(p.gx);
      dr.gy = static_cast<float>(p.gy);
      dr.opacity = static_cast<float>(p.opacity);
      dr.scale = static_cast<float>(p.scale);
      dr.u0 = ld.u0;
      dr.v0 = ld.v0;
      dr.u1 = ld.u1;
      dr.v1 = ld.v1;
      dr.kind = ld.kind;
      labelsFading = labelsFading || (p.opacity > 0 && p.opacity < 1);
      out.labels.push_back(dr);
    }
    stats_.labelsShown = static_cast<int>(out.labels.size());

    // Trails / recording / routes, lifted onto the terrain.
    for (auto& [id, pl] : polylines_) {
      if (pl.points.size() < 2) continue;
      const bool needLift = !pl.vertices || (pl.liftedDemGen != demGen && now - pl.liftedAt > 400);
      if (needLift) {
        pl.originX = pl.points[0][0];
        pl.originY = pl.points[0][1];
        const double latc = mercYToLat(pl.originY);
        const double step = 15.0 / (kEarthCircumferenceM * std::cos(latc * kPi / 180));
        const auto dense = densify(pl.points, step);
        std::vector<float> hs(dense.size());
        for (size_t k = 0; k < dense.size(); k++)
          hs[k] = static_cast<float>(heightAt(dense[k][0], dense[k][1], kDemMaxZoom).value_or(0.0));
        auto verts = std::make_shared<std::vector<float>>();
        verts->reserve((dense.size() - 1) * 6 * 8);
        const float sides[6] = {-1, 1, 1, -1, 1, -1};
        const float ends[6] = {0, 0, 1, 0, 1, 1};
        for (size_t k = 0; k + 1 < dense.size(); k++) {
          const float ax = static_cast<float>(dense[k][0] - pl.originX);
          const float ay = static_cast<float>(dense[k][1] - pl.originY);
          const float bx = static_cast<float>(dense[k + 1][0] - pl.originX);
          const float by = static_cast<float>(dense[k + 1][1] - pl.originY);
          for (int v = 0; v < 6; v++) {
            verts->insert(verts->end(), {ax, ay, hs[k], bx, by, hs[k + 1], sides[v], ends[v]});
          }
        }
        pl.vertices = std::move(verts);
        pl.version = ++lineVersion_;
        pl.liftedDemGen = demGen;
        pl.liftedAt = now;
      }
      LineDraw ld;
      ld.id = id;
      ld.version = pl.version;
      ld.vertices = pl.vertices;
      ld.style = pl.style;
      const double ox = worldX(pl.originX);
      const Mat4 m =
          multiply(in.P, multiply(translation(ox, pl.originY * ws, 0), scaling(ws, ws, 1)));
      for (int i = 0; i < 16; i++) ld.matrix[i] = static_cast<float>(m[i]);
      out.lines.push_back(std::move(ld));
    }
    std::stable_sort(out.lines.begin(), out.lines.end(),
                     [](const LineDraw& a, const LineDraw& b) { return a.style.order < b.style.order; });

    // The location marker.
    if (puckVisible_) {
      const double h = heightAt(puckX_, puckY_, kDemMaxZoom).value_or(hRef);
      const Vec4 v = transform(in.P, {worldX(puckX_), puckY_ * ws, (h - hRef) * heightScale, 1});
      if (v[3] > 1e-9) {
        out.puck.visible = true;
        out.puck.gx = static_cast<float>((v[0] / v[3] * 0.5 + 0.5) * in.width);
        out.puck.gy = static_cast<float>((0.5 - v[1] / v[3] * 0.5) * in.height);
        out.puck.opacity = 1;
      }
    }
  }

  out.needsRepaint = morphing || bakesPending || hRefSettling || labelsFading || imageryFading ||
                     !out.imageryUploads.empty();
  stats_.tilesDrawn = static_cast<int>(out.tiles.size());
  stats_.flatTiles = flat;
  stats_.meshCount = static_cast<int>(meshes_.size());
  stats_.bakeQueue = queued;
  {
    std::lock_guard<std::mutex> lock(imgMutex_);
    stats_.imagerySlots = imgSlotCount_ - static_cast<int>(freeImgSlots_.size());
  }
  stats_.hRef = hRef;
  stats_.imageryUploads += static_cast<int>(out.imageryUploads.size());
  stats_.lastFrameCpuMs = nowCpuMs() - cpuStart;
  return out;
}

}  // namespace inukshuk::terrain
