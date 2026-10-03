#include "terrain_core.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_set>

namespace inukshuk::terrain {

namespace {
constexpr double kDeg2Rad = kPi / 180.0;
}

// ---- mat4 ------------------------------------------------------------------

Mat4 identity() { return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}; }

Mat4 multiply(const Mat4& a, const Mat4& b) {
  Mat4 out{};
  for (int c = 0; c < 4; c++) {
    for (int r = 0; r < 4; r++) {
      double s = 0;
      for (int k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

Vec4 transform(const Mat4& m, const Vec4& v) {
  const double x = v[0], y = v[1], z = v[2], w = v[3];
  return {m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w,
          m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w};
}

std::optional<Mat4> invert(const Mat4& m) {
  const double a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const double a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const double a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const double a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const double b00 = a00 * a11 - a01 * a10;
  const double b01 = a00 * a12 - a02 * a10;
  const double b02 = a00 * a13 - a03 * a10;
  const double b03 = a01 * a12 - a02 * a11;
  const double b04 = a01 * a13 - a03 * a11;
  const double b05 = a02 * a13 - a03 * a12;
  const double b06 = a20 * a31 - a21 * a30;
  const double b07 = a20 * a32 - a22 * a30;
  const double b08 = a20 * a33 - a23 * a30;
  const double b09 = a21 * a32 - a22 * a31;
  const double b10 = a21 * a33 - a23 * a31;
  const double b11 = a22 * a33 - a23 * a32;
  const double det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!std::isfinite(det) || std::abs(det) < 1e-300) return std::nullopt;
  const double d = 1.0 / det;
  return Mat4{(a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
              (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
              (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
              (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
              (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
              (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
              (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
              (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d};
}

Mat4 translation(double x, double y, double z) {
  return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1};
}

Mat4 scaling(double x, double y, double z) {
  return {x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1};
}

std::optional<Vec3> dehomogenize(const Vec4& v) {
  if (!std::isfinite(v[3]) || std::abs(v[3]) < 1e-12) return std::nullopt;
  return Vec3{v[0] / v[3], v[1] / v[3], v[2] / v[3]};
}

// ---- mercator --------------------------------------------------------------

double clampLat(double lat) { return std::max(-kMaxMercatorLat, std::min(kMaxMercatorLat, lat)); }

double worldSize(double zoom) { return kWorldTileSize * std::pow(2.0, zoom); }

double lngToMercX(double lng) { return (lng + 180.0) / 360.0; }

double latToMercY(double lat) {
  const double phi = clampLat(lat) * kDeg2Rad;
  return (1.0 - std::log(std::tan(kPi / 4.0 + phi / 2.0)) / kPi) / 2.0;
}

double mercXToLng(double x) { return x * 360.0 - 180.0; }

double mercYToLat(double y) {
  const double n = kPi * (1.0 - 2.0 * y);
  return std::atan(std::sinh(n)) * 180.0 / kPi;
}

double pixelsPerMeter(double lat, double zoom) {
  return worldSize(zoom) / (kEarthCircumferenceM * std::cos(clampLat(lat) * kDeg2Rad));
}

double tileSizeMeters(int z, double lat) {
  return kEarthCircumferenceM * std::cos(clampLat(lat) * kDeg2Rad) / std::pow(2.0, z);
}

// ---- camera helpers ----------------------------------------------------------

double cameraToCenterDistance(double height, double fovRad) {
  return 0.5 * height / std::tan(fovRad / 2.0);
}

std::optional<Vec3> eyeFromProjection(const Mat4& P) {
  auto inv = invert(P);
  if (!inv) return std::nullopt;
  return dehomogenize(transform(*inv, {0, 0, 1, 0}));
}

std::optional<std::pair<double, double>> groundAtNdc(const Mat4& invP, double ndcX, double ndcY,
                                                     double groundZ) {
  auto nearP = dehomogenize(transform(invP, {ndcX, ndcY, 0, 1}));
  auto farP = dehomogenize(transform(invP, {ndcX, ndcY, 1, 1}));
  if (!nearP || !farP) return std::nullopt;
  const double dz = (*farP)[2] - (*nearP)[2];
  if (std::abs(dz) < 1e-12) return std::nullopt;
  const double s = (groundZ - (*nearP)[2]) / dz;
  if (s < 0) return std::nullopt;
  return std::make_pair((*nearP)[0] + ((*farP)[0] - (*nearP)[0]) * s,
                        (*nearP)[1] + ((*farP)[1] - (*nearP)[1]) * s);
}

// ---- frustum -----------------------------------------------------------------

namespace {
Plane row(const Mat4& P, int i) { return {P[i], P[4 + i], P[8 + i], P[12 + i]}; }
Plane addPlanes(const Plane& a, const Plane& b, double sign) {
  return {a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2], a[3] + sign * b[3]};
}
Plane normalizePlane(const Plane& p) {
  const double l = std::hypot(p[0], p[1], p[2]);
  return l > 0 ? Plane{p[0] / l, p[1] / l, p[2] / l, p[3] / l} : p;
}
}  // namespace

std::array<Plane, 5> frustumPlanes(const Mat4& P) {
  const Plane r0 = row(P, 0), r1 = row(P, 1), r3 = row(P, 3);
  return {normalizePlane(addPlanes(r3, r0, 1)), normalizePlane(addPlanes(r3, r0, -1)),
          normalizePlane(addPlanes(r3, r1, 1)), normalizePlane(addPlanes(r3, r1, -1)),
          normalizePlane(r3)};
}

bool aabbOutside(const std::array<Plane, 5>& planes, const Aabb& b) {
  for (const auto& p : planes) {
    const double x = p[0] >= 0 ? b.maxX : b.minX;
    const double y = p[1] >= 0 ? b.maxY : b.minY;
    const double z = p[2] >= 0 ? b.maxZ : b.minZ;
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return true;
  }
  return false;
}

double distanceToAabb(double px, double py, double pz, const Aabb& b, double zScale) {
  const double dx = std::max({b.minX - px, 0.0, px - b.maxX});
  const double dy = std::max({b.minY - py, 0.0, py - b.maxY});
  const double dz = std::max({b.minZ - pz, 0.0, pz - b.maxZ}) * zScale;
  return std::hypot(dx, dy, dz);
}

// ---- tiles -------------------------------------------------------------------

std::string tileKey(const TileId& t) {
  return std::to_string(t.z) + "/" + std::to_string(t.x) + "/" + std::to_string(t.y) + "/" +
         std::to_string(t.wrap);
}

std::string demKey(const DemId& d) {
  return std::to_string(d.z) + "/" + std::to_string(d.x) + "/" + std::to_string(d.y);
}

uint64_t meshKey(int z, int x, int y) {
  return (static_cast<uint64_t>(z) << 58) | (static_cast<uint64_t>(x) << 29) |
         static_cast<uint64_t>(y);
}

uint64_t demKey64(const DemId& d) { return meshKey(d.z, d.x, d.y); }

TileBounds tileBoundsPx(const TileId& t, double zoom) {
  const double ws = worldSize(zoom);
  const double size = ws / std::pow(2.0, t.z);
  const double minX = t.x * size + t.wrap * ws;
  const double minY = t.y * size;
  return {minX, minY, minX + size, minY + size, size};
}

DemWindow demWindow(const TileId& t, int maxDemZoom) {
  const int dz = std::min(t.z, maxDemZoom);
  const int d = t.z - dz;
  const double k = std::pow(2.0, d);
  DemWindow w;
  w.dem = {dz, t.x >> d, t.y >> d};
  w.offsetX = (t.x - w.dem.x * k) / k;
  w.offsetY = (t.y - w.dem.y * k) / k;
  w.scale = 1.0 / k;
  return w;
}

DemWindow demWindowAt(const TileId& t, int demZ) {
  const int dz = std::max(0, std::min(demZ, t.z));
  const int d = t.z - dz;
  const double k = std::pow(2.0, d);
  DemWindow w;
  w.dem = {dz, t.x >> d, t.y >> d};
  w.offsetX = (t.x - w.dem.x * k) / k;
  w.offsetY = (t.y - w.dem.y * k) / k;
  w.scale = 1.0 / k;
  return w;
}

std::optional<DemId> demNeighbor(const DemId& d, int dx, int dy) {
  const int n = 1 << d.z;
  const int y = d.y + dy;
  if (y < 0 || y >= n) return std::nullopt;
  const int x = (((d.x + dx) % n) + n) % n;
  return DemId{d.z, x, y};
}

bool isAncestorOf(const TileId& a, const TileId& b) {
  if (a.z >= b.z || a.wrap != b.wrap) return false;
  const int d = b.z - a.z;
  return (b.x >> d) == a.x && (b.y >> d) == a.y;
}

// ---- lod ---------------------------------------------------------------------

std::pair<double, double> displayedZRange(double minH, double maxH, double hRef,
                                          double heightScale) {
  const double a = (minH - hRef) * heightScale;
  const double b = (maxH - hRef) * heightScale;
  return a <= b ? std::make_pair(a, b) : std::make_pair(b, a);
}

double screenSpaceError(double tileSizePx, int grid, double ctc, double distance) {
  return ((tileSizePx / grid) * ctc) / std::max(distance, 1e-6);
}

namespace {
struct WalkResult {
  std::vector<SelectedTile> tiles;
  int visited = 0;
  bool overflow = false;
};

WalkResult walk(const FrameCamera& cam, const LodOptions& opts, double threshold, const Vec3& eye,
                double ctc) {
  const auto planes = frustumPlanes(cam.P);
  const double ppm = pixelsPerMeter(cam.lat, cam.zoom);
  const double fogEnd = opts.fogEndCtc * ctc;
  const int maxZ =
      std::min(opts.maxZoom, static_cast<int>(std::floor(cam.zoom)) + kMaxZoomAboveCamera);
  WalkResult r;
  std::vector<TileId> stack = {{0, 0, 0, -1}, {0, 0, 0, 0}, {0, 0, 0, 1}};
  while (!stack.empty()) {
    const TileId t = stack.back();
    stack.pop_back();
    r.visited++;
    if (r.visited > kMaxVisits) {
      r.overflow = true;
      break;
    }
    const TileBounds b = tileBoundsPx(t, cam.zoom);
    double minH = kUnknownMinH, maxH = kUnknownMaxH;
    if (opts.heightRange) {
      if (auto range = opts.heightRange(t)) {
        minH = range->first;
        maxH = range->second;
      }
    }
    const auto [zMin, zMax] = displayedZRange(minH, maxH, opts.hRef, opts.heightScale);
    const Aabb box{b.minX, b.minY, zMin, b.maxX, b.maxY, zMax};
    if (aabbOutside(planes, box)) continue;
    const double distance = distanceToAabb(eye[0], eye[1], eye[2], box, ppm);
    if (distance > fogEnd) continue;
    const double sse = screenSpaceError(b.size, opts.grid, ctc, distance);
    if (sse > threshold && t.z < maxZ) {
      const int z = t.z + 1, x = t.x * 2, y = t.y * 2;
      stack.push_back({z, x, y, t.wrap});
      stack.push_back({z, x + 1, y, t.wrap});
      stack.push_back({z, x, y + 1, t.wrap});
      stack.push_back({z, x + 1, y + 1, t.wrap});
    } else {
      r.tiles.push_back({t, distance, sse});
      if (static_cast<int>(r.tiles.size()) > opts.maxTiles) {
        r.overflow = true;
        break;
      }
    }
  }
  return r;
}
}  // namespace

Selection selectTiles(const FrameCamera& cam, const LodOptions& opts) {
  Selection sel;
  sel.ctc = 0.5 * cam.height / std::tan(cam.fovRad / 2.0);
  sel.eye = eyeFromProjection(cam.P);
  sel.threshold = opts.maxErrorPx;
  if (!sel.eye || !std::isfinite(sel.ctc) || sel.ctc <= 0) return sel;
  double threshold = opts.maxErrorPx;
  int visitedTotal = 0;
  for (int attempt = 0; attempt < 24; attempt++) {
    WalkResult r = walk(cam, opts, threshold, *sel.eye, sel.ctc);
    visitedTotal += r.visited;
    if (!r.overflow) {
      std::stable_sort(r.tiles.begin(), r.tiles.end(),
                       [](const SelectedTile& a, const SelectedTile& b) {
                         if (a.distance != b.distance) return a.distance < b.distance;
                         return a.tile.z < b.tile.z;
                       });
      sel.tiles = std::move(r.tiles);
      sel.threshold = threshold;
      sel.visited = visitedTotal;
      return sel;
    }
    threshold *= 1.25;
  }
  sel.threshold = threshold;
  sel.visited = visitedTotal;
  return sel;
}

// ---- dem ---------------------------------------------------------------------

double terrariumRaw(int r, int g, int b) { return r * 256.0 + g + b / 256.0 - 32768.0; }

double terrariumHeight(int r, int g, int b, bool clampSeaLevel) {
  const double h = terrariumRaw(r, g, b);
  if (!std::isfinite(h) || h < kMinValidElevation || h > kMaxValidElevation) return 0;
  if (clampSeaLevel && h < 0) return 0;
  return h;
}

std::vector<float> decodeTerrarium(const uint8_t* pixels, int width, int height, int channels,
                                   bool clampSeaLevel) {
  const int n = width * height;
  std::vector<float> out(static_cast<size_t>(n));
  for (int i = 0; i < n; i++) {
    const uint8_t* p = pixels + static_cast<size_t>(i) * channels;
    out[i] = static_cast<float>(terrariumHeight(p[0], p[1], p[2], clampSeaLevel));
  }
  return out;
}

std::pair<float, float> demStats(const std::vector<float>& h) {
  if (h.empty()) return {0.f, 0.f};
  float mn = std::numeric_limits<float>::infinity(), mx = -mn;
  for (float v : h) {
    mn = std::min(mn, v);
    mx = std::max(mx, v);
  }
  return {mn, mx};
}

namespace {
inline double px(const float* h, int size, int ix, int iy) {
  const int x = ix < 0 ? 0 : ix >= size ? size - 1 : ix;
  const int y = iy < 0 ? 0 : iy >= size ? size - 1 : iy;
  return h[y * size + x];
}
}  // namespace

double sampleDem(const float* h, int size, double u, double v) {
  const double fx = u * size - 0.5, fy = v * size - 0.5;
  const int x0 = static_cast<int>(std::floor(fx)), y0 = static_cast<int>(std::floor(fy));
  const double tx = fx - x0, ty = fy - y0;
  const double a = px(h, size, x0, y0), b = px(h, size, x0 + 1, y0);
  const double c = px(h, size, x0, y0 + 1), d = px(h, size, x0 + 1, y0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

double mosaicPixel(const DemNeighborhood& n, int ix, int iy) {
  const int s = n.size;
  const int dx = ix < 0 ? -1 : ix >= s ? 1 : 0;
  const int dy = iy < 0 ? -1 : iy >= s ? 1 : 0;
  if (dx == 0 && dy == 0) return n.center[iy * s + ix];
  const float* nb = n.neighbor(dx, dy);
  if (!nb) return px(n.center, s, ix, iy);
  return px(nb, s, ix - dx * s, iy - dy * s);
}

double sampleMosaic(const DemNeighborhood& n, double u, double v) {
  const double fx = u * n.size - 0.5, fy = v * n.size - 0.5;
  const int x0 = static_cast<int>(std::floor(fx)), y0 = static_cast<int>(std::floor(fy));
  const double tx = fx - x0, ty = fy - y0;
  const double a = mosaicPixel(n, x0, y0), b = mosaicPixel(n, x0 + 1, y0);
  const double c = mosaicPixel(n, x0, y0 + 1), d = mosaicPixel(n, x0 + 1, y0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

// ---- mesh --------------------------------------------------------------------

int gridVertexCount(int n) { return (n + 1) * (n + 1); }
int vertexCount(int n) { return gridVertexCount(n) + 4 * (n + 1); }
int triangleCount(int n) { return 2 * n * n + 8 * n; }
int gridIndex(int n, int i, int j) { return j * (n + 1) + i; }

int skirtSource(int n, int k) {
  const int e = k - gridVertexCount(n);
  const int side = e / (n + 1);
  const int t = e % (n + 1);
  switch (side) {
    case 0:
      return gridIndex(n, t, 0);
    case 1:
      return gridIndex(n, t, n);
    case 2:
      return gridIndex(n, 0, t);
    default:
      return gridIndex(n, n, t);
  }
}

std::vector<float> buildGridVertices(int n) {
  std::vector<float> out;
  out.reserve(static_cast<size_t>(vertexCount(n)) * 3);
  auto put = [&](double u, double v, float s) {
    out.push_back(static_cast<float>(u));
    out.push_back(static_cast<float>(v));
    out.push_back(s);
  };
  for (int j = 0; j <= n; j++)
    for (int i = 0; i <= n; i++) put(static_cast<double>(i) / n, static_cast<double>(j) / n, 0);
  for (int i = 0; i <= n; i++) put(static_cast<double>(i) / n, 0, 1);
  for (int i = 0; i <= n; i++) put(static_cast<double>(i) / n, 1, 1);
  for (int j = 0; j <= n; j++) put(0, static_cast<double>(j) / n, 1);
  for (int j = 0; j <= n; j++) put(1, static_cast<double>(j) / n, 1);
  return out;
}

std::vector<uint32_t> buildGridIndices(int n) {
  std::vector<uint32_t> out;
  out.reserve(static_cast<size_t>(triangleCount(n)) * 3);
  auto tri = [&](int a, int b, int c) {
    out.push_back(static_cast<uint32_t>(a));
    out.push_back(static_cast<uint32_t>(b));
    out.push_back(static_cast<uint32_t>(c));
  };
  for (int j = 0; j < n; j++) {
    for (int i = 0; i < n; i++) {
      const int a = gridIndex(n, i, j), b = gridIndex(n, i + 1, j);
      const int c = gridIndex(n, i, j + 1), d = gridIndex(n, i + 1, j + 1);
      tri(a, c, d);
      tri(a, d, b);
    }
  }
  const int g = gridVertexCount(n);
  for (int side = 0; side < 4; side++) {
    const int base = g + side * (n + 1);
    for (int t = 0; t < n; t++) {
      int e0, e1;
      switch (side) {
        case 0:
          e0 = gridIndex(n, t, 0);
          e1 = gridIndex(n, t + 1, 0);
          break;
        case 1:
          e0 = gridIndex(n, t, n);
          e1 = gridIndex(n, t + 1, n);
          break;
        case 2:
          e0 = gridIndex(n, 0, t);
          e1 = gridIndex(n, 0, t + 1);
          break;
        default:
          e0 = gridIndex(n, n, t);
          e1 = gridIndex(n, n, t + 1);
          break;
      }
      tri(e0, base + t, e1);
      tri(e1, base + t, base + t + 1);
    }
  }
  return out;
}

std::vector<float> bakeHeights(int n, const std::function<double(double, double)>& sample) {
  std::vector<float> out(static_cast<size_t>(gridVertexCount(n)));
  for (int j = 0; j <= n; j++)
    for (int i = 0; i <= n; i++)
      out[gridIndex(n, i, j)] =
          static_cast<float>(sample(static_cast<double>(i) / n, static_cast<double>(j) / n));
  return out;
}

std::vector<float> bakeSlopes(int n, const std::function<double(double, double)>& sample,
                              double cellMeters) {
  std::vector<float> out(static_cast<size_t>(gridVertexCount(n)) * 2);
  const double inv = 1.0 / (2.0 * cellMeters);
  const double d = 1.0 / n;
  for (int j = 0; j <= n; j++) {
    for (int i = 0; i <= n; i++) {
      const double u = static_cast<double>(i) / n, v = static_cast<double>(j) / n;
      const double sx = (sample(u + d, v) - sample(u - d, v)) * inv;
      const double sy = (sample(u, v + d) - sample(u, v - d)) * inv;
      const int k = gridIndex(n, i, j) * 2;
      out[k] = static_cast<float>(sx);
      out[k + 1] = static_cast<float>(sy);
    }
  }
  return out;
}

std::vector<float> coarseSurface(int n, const std::function<double(int, int)>& eh) {
  std::vector<float> out(static_cast<size_t>(gridVertexCount(n)));
  for (int j = 0; j <= n; j++) {
    for (int i = 0; i <= n; i++) {
      double h;
      if (i % 2 == 0 && j % 2 == 0)
        h = eh(i / 2, j / 2);
      else if (i % 2 == 1 && j % 2 == 0)
        h = (eh((i - 1) / 2, j / 2) + eh((i + 1) / 2, j / 2)) / 2;
      else if (i % 2 == 0 && j % 2 == 1)
        h = (eh(i / 2, (j - 1) / 2) + eh(i / 2, (j + 1) / 2)) / 2;
      else
        h = (eh((i - 1) / 2, (j - 1) / 2) + eh((i + 1) / 2, (j + 1) / 2)) / 2;
      out[gridIndex(n, i, j)] = static_cast<float>(h);
    }
  }
  return out;
}

std::vector<float> parentSurfaceForChild(int n, const std::vector<float>& parentHeights, int qx,
                                         int qy) {
  const int h = n / 2;
  return coarseSurface(
      n, [&](int a, int b) { return parentHeights[gridIndex(n, qx * h + a, qy * h + b)]; });
}

std::vector<float> packAttributes(int n, const std::vector<float>& hFrom,
                                  const std::vector<float>& hTo, const std::vector<float>& slopes) {
  const int count = vertexCount(n);
  const int g = gridVertexCount(n);
  std::vector<float> out(static_cast<size_t>(count) * kAttributesPerVertex);
  for (int k = 0; k < count; k++) {
    const int s = k < g ? k : skirtSource(n, k);
    const size_t o = static_cast<size_t>(k) * kAttributesPerVertex;
    out[o] = hFrom[s];
    out[o + 1] = hTo[s];
    out[o + 2] = slopes[s * 2];
    out[o + 3] = slopes[s * 2 + 1];
  }
  return out;
}

double skirtDepth(double tileMeters) { return std::min(1500.0, std::max(15.0, tileMeters * 0.03)); }

double surfaceAt(int n, const std::vector<float>& heights, double u, double v) {
  const double fx = std::min(std::max(u, 0.0), 1.0) * n;
  const double fy = std::min(std::max(v, 0.0), 1.0) * n;
  const int i = std::min(static_cast<int>(std::floor(fx)), n - 1);
  const int j = std::min(static_cast<int>(std::floor(fy)), n - 1);
  const double tx = fx - i, ty = fy - j;
  const double a = heights[gridIndex(n, i, j)], b = heights[gridIndex(n, i + 1, j)];
  const double c = heights[gridIndex(n, i, j + 1)], d = heights[gridIndex(n, i + 1, j + 1)];
  if (ty >= tx) return a + (c - a) * ty + (d - c) * tx;
  return a + (b - a) * tx + (d - b) * ty;
}

// ---- morph / look --------------------------------------------------------------

double clamp01(double x) { return x <= 0 ? 0 : x >= 1 ? 1 : x; }

double smoothstep(double e0, double e1, double x) {
  if (!std::isfinite(x)) return 0;
  if (e1 == e0) return x < e0 ? 0 : 1;
  const double t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

double pitchRamp(double pitchDeg, double start, double full) {
  return smoothstep(start, full, pitchDeg);
}

double morphFactor(double elapsedMs, double durationMs) {
  if (!std::isfinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (durationMs <= 0) return 0;
  return 1 - smoothstep(0, durationMs, elapsedMs);
}

double fogAmount(double fogStartCtc, double fogDensity, double fogEndCtc, double distanceCtc) {
  if (!std::isfinite(distanceCtc) || distanceCtc <= fogStartCtc) return 0;
  const double e = 1 - std::exp(-fogDensity * (distanceCtc - fogStartCtc));
  const double t = clamp01((distanceCtc - fogEndCtc * 0.85) / (fogEndCtc * 0.15));
  const double wall = t * t * (3 - 2 * t);
  return clamp01(std::max(e, wall));
}

Vec3 lightDirection(double bearingDeg, double azimuthDeg, double altitudeDeg) {
  const double az = (bearingDeg + azimuthDeg) * kDeg2Rad;
  const double alt = altitudeDeg * kDeg2Rad;
  return {std::sin(az) * std::cos(alt), -std::cos(az) * std::cos(alt), std::sin(alt)};
}

double formShade(double slopeX, double slopeY, double exaggeration, const Vec3& light,
                 double strength, double ramp) {
  const double nx = -slopeX * exaggeration, ny = -slopeY * exaggeration;
  const double len = std::hypot(nx, ny, 1.0);
  const double lambert = std::max(0.0, (nx * light[0] + ny * light[1] + light[2]) / len);
  return 1 + (lambert - light[2]) * strength * 2 * ramp;
}

// ---- reference / prefetch ---------------------------------------------------------

double referenceHeight(const std::vector<std::optional<double>>& samples) {
  double best = -std::numeric_limits<double>::infinity();
  for (const auto& s : samples)
    if (s && std::isfinite(*s) && *s > best) best = *s;
  return std::isinf(best) ? 0 : best;
}

double smoothToward(std::optional<double> current, double target, double dtMs, double tauMs,
                    double epsilon) {
  if (!current || !std::isfinite(*current)) return target;
  if (!std::isfinite(dtMs) || dtMs <= 0) return *current;
  const double a = 1 - std::exp(-dtMs / std::max(tauMs, 1e-6));
  const double next = *current + (target - *current) * a;
  return std::abs(next - target) < epsilon ? target : next;
}

std::vector<DemId> planDemRequests(const std::vector<TileId>& tiles, double bearingDeg,
                                   const std::function<bool(const DemId&)>& isLoaded,
                                   const std::function<bool(const DemId&)>& isPending,
                                   int maxRequests) {
  std::vector<DemId> out;
  std::unordered_set<uint64_t> seen;
  auto want = [&](const DemId& d) {
    if (static_cast<int>(out.size()) >= maxRequests) return;
    if (!seen.insert(demKey64(d)).second) return;
    if (isLoaded(d) || (isPending && isPending(d))) return;
    out.push_back(d);
  };
  std::vector<DemId> own;
  own.reserve(tiles.size());
  for (const auto& t : tiles) {
    const DemId d = demWindow(t).dem;
    const int bz = std::min(d.z, kBaseZoom);
    want({bz, d.x >> (d.z - bz), d.y >> (d.z - bz)});
    const int az = std::max(0, d.z - kCoarseLead);
    const int k = d.z - az;
    want({az, d.x >> k, d.y >> k});
    want(d);
    own.push_back(d);
  }
  const double b = bearingDeg * kDeg2Rad;
  const double fx = std::sin(b), fy = -std::cos(b);
  for (const auto& d : own) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        if (dx * fx + dy * fy <= 0.3) continue;
        if (auto n = demNeighbor(d, dx, dy)) want(*n);
      }
    }
  }
  return out;
}

std::optional<int> bestLoadedDemZoom(const TileId& t,
                                     const std::function<bool(const DemId&)>& isLoaded) {
  const DemId own = demWindow(t).dem;
  for (int z = own.z; z >= 0; z--) {
    const int k = own.z - z;
    if (isLoaded({z, own.x >> k, own.y >> k})) return z;
  }
  return std::nullopt;
}

}  // namespace inukshuk::terrain
