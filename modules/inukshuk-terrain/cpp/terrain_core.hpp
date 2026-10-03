// Pure terrain math — the C++ twin of src/core/terrain3d (TypeScript is the
// spec; tests/terrain_tests.cpp checks parity against fixtures generated from
// it). No platform or GPU code here.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <unordered_map>
#include <string>
#include <utility>
#include <vector>

namespace inukshuk::terrain {

using Mat4 = std::array<double, 16>;  // column-major, like MapLibre
using Vec3 = std::array<double, 3>;
using Vec4 = std::array<double, 4>;
using Plane = std::array<double, 4>;

// ---- mat4 ------------------------------------------------------------------
Mat4 identity();
Mat4 multiply(const Mat4& a, const Mat4& b);
Vec4 transform(const Mat4& m, const Vec4& v);
std::optional<Mat4> invert(const Mat4& m);
Mat4 translation(double x, double y, double z);
Mat4 scaling(double x, double y, double z);
std::optional<Vec3> dehomogenize(const Vec4& v);

// ---- mercator --------------------------------------------------------------
constexpr double kWorldTileSize = 512.0;
constexpr double kEarthRadiusM = 6378137.0;
constexpr double kPi = 3.14159265358979323846;
constexpr double kEarthCircumferenceM = 2.0 * kPi * kEarthRadiusM;
constexpr double kMaxMercatorLat = 85.051128779806604;

double clampLat(double lat);
double worldSize(double zoom);
double lngToMercX(double lng);
double latToMercY(double lat);
double mercXToLng(double x);
double mercYToLat(double y);
double pixelsPerMeter(double lat, double zoom);
double tileSizeMeters(int z, double lat);

// ---- camera helpers ----------------------------------------------------------
double cameraToCenterDistance(double height, double fovRad);
std::optional<Vec3> eyeFromProjection(const Mat4& P);
std::optional<std::pair<double, double>> groundAtNdc(const Mat4& invP, double ndcX, double ndcY,
                                                     double groundZ = 0.0);

// ---- frustum -----------------------------------------------------------------
struct Aabb {
  double minX, minY, minZ, maxX, maxY, maxZ;
};
std::array<Plane, 5> frustumPlanes(const Mat4& P);
bool aabbOutside(const std::array<Plane, 5>& planes, const Aabb& b);
double distanceToAabb(double px, double py, double pz, const Aabb& b, double zScale);

// ---- tiles -------------------------------------------------------------------
constexpr int kDemMaxZoom = 15;
constexpr int kTerrainMaxZoom = 17;

struct TileId {
  int z = 0, x = 0, y = 0, wrap = 0;
  bool operator==(const TileId& o) const {
    return z == o.z && x == o.x && y == o.y && wrap == o.wrap;
  }
};
struct DemId {
  int z = 0, x = 0, y = 0;
  bool operator==(const DemId& o) const { return z == o.z && x == o.x && y == o.y; }
};
struct DemWindow {
  DemId dem;
  double offsetX = 0, offsetY = 0, scale = 1;
};
struct TileBounds {
  double minX, minY, maxX, maxY, size;
};

std::string tileKey(const TileId& t);
std::string demKey(const DemId& d);
/** Mesh cache key: heights don't depend on the world copy. */
uint64_t meshKey(int z, int x, int y);
uint64_t demKey64(const DemId& d);
TileBounds tileBoundsPx(const TileId& t, double zoom);
DemWindow demWindow(const TileId& t, int maxDemZoom = kDemMaxZoom);
DemWindow demWindowAt(const TileId& t, int demZ);
std::optional<DemId> demNeighbor(const DemId& d, int dx, int dy);
bool isAncestorOf(const TileId& a, const TileId& b);

// ---- lod ---------------------------------------------------------------------
constexpr int kGrid = 32;
constexpr double kDefaultMaxErrorPx = 10.0;
constexpr int kDefaultMaxTiles = 240;
constexpr double kDefaultFogEndCtc = 12.0;
constexpr int kMaxZoomAboveCamera = 3;
constexpr double kUnknownMinH = -100.0;
constexpr double kUnknownMaxH = 9000.0;
constexpr int kMaxVisits = 20000;

struct FrameCamera {
  Mat4 P;
  double width = 0, height = 0, fovRad = 0, zoom = 0, lat = 0;
};
struct LodOptions {
  int grid = kGrid;
  double maxErrorPx = kDefaultMaxErrorPx;
  int maxTiles = kDefaultMaxTiles;
  int maxZoom = kTerrainMaxZoom;
  double fogEndCtc = kDefaultFogEndCtc;
  /** Absolute [min, max] (m) known for a tile; nullopt = unknown. */
  std::function<std::optional<std::pair<double, double>>(const TileId&)> heightRange;
  double hRef = 0;
  double heightScale = 1;
};
struct SelectedTile {
  TileId tile;
  double distance = 0;
  double sse = 0;
};
struct Selection {
  std::vector<SelectedTile> tiles;
  double threshold = 0;
  int visited = 0;
  std::optional<Vec3> eye;
  double ctc = 0;
};

std::pair<double, double> displayedZRange(double minH, double maxH, double hRef, double heightScale);
double screenSpaceError(double tileSizePx, int grid, double ctc, double distance);
Selection selectTiles(const FrameCamera& cam, const LodOptions& opts);

// ---- dem ---------------------------------------------------------------------
constexpr int kDemSize = 256;
constexpr double kMinValidElevation = -12000.0;
constexpr double kMaxValidElevation = 9000.0;

double terrariumRaw(int r, int g, int b);
double terrariumHeight(int r, int g, int b, bool clampSeaLevel = true);
/** Decode interleaved pixels (3 = RGB, 4 = RGBA). */
std::vector<float> decodeTerrarium(const uint8_t* pixels, int width, int height, int channels,
                                   bool clampSeaLevel = true);
std::pair<float, float> demStats(const std::vector<float>& h);
double sampleDem(const float* h, int size, double u, double v);

/** A DEM tile with whichever of its 8 neighbours are loaded (nullptr = missing). */
struct DemNeighborhood {
  int size = kDemSize;
  const float* center = nullptr;
  std::array<const float*, 9> around{};  // index (dy+1)*3 + (dx+1); [4] == center
  const float* neighbor(int dx, int dy) const { return around[(dy + 1) * 3 + (dx + 1)]; }
};
double mosaicPixel(const DemNeighborhood& n, int ix, int iy);
double sampleMosaic(const DemNeighborhood& n, double u, double v);

// ---- mesh --------------------------------------------------------------------
constexpr int kAttributesPerVertex = 4;
int gridVertexCount(int n);
int vertexCount(int n);
int triangleCount(int n);
int gridIndex(int n, int i, int j);
int skirtSource(int n, int k);
std::vector<float> buildGridVertices(int n);
std::vector<uint32_t> buildGridIndices(int n);
std::vector<float> bakeHeights(int n, const std::function<double(double, double)>& sample);
std::vector<float> bakeSlopes(int n, const std::function<double(double, double)>& sample,
                              double cellMeters);
std::vector<float> coarseSurface(int n, const std::function<double(int, int)>& evenHeight);
std::vector<float> parentSurfaceForChild(int n, const std::vector<float>& parentHeights, int qx,
                                         int qy);
std::vector<float> packAttributes(int n, const std::vector<float>& hFrom,
                                  const std::vector<float>& hTo, const std::vector<float>& slopes);
double skirtDepth(double tileMeters);
double surfaceAt(int n, const std::vector<float>& heights, double u, double v);

// ---- morph / look --------------------------------------------------------------
constexpr double kRampStartDeg = 25.0;
constexpr double kRampFullDeg = 45.0;
constexpr double kMorphMs = 280.0;
constexpr double kTerrainMaxPitchDeg = 80.0;
constexpr double kLightAzimuthDeg = 335.0;
constexpr double kLightAltitudeDeg = 45.0;

double clamp01(double x);
double smoothstep(double e0, double e1, double x);
double pitchRamp(double pitchDeg, double start = kRampStartDeg, double full = kRampFullDeg);
double morphFactor(double elapsedMs, double durationMs = kMorphMs);
double fogAmount(double fogStartCtc, double fogDensity, double fogEndCtc, double distanceCtc);
Vec3 lightDirection(double bearingDeg, double azimuthDeg = kLightAzimuthDeg,
                    double altitudeDeg = kLightAltitudeDeg);
double formShade(double slopeX, double slopeY, double exaggeration, const Vec3& light,
                 double strength, double ramp);

// ---- reference / prefetch ---------------------------------------------------------
double referenceHeight(const std::vector<std::optional<double>>& samples);
double smoothToward(std::optional<double> current, double target, double dtMs, double tauMs = 150,
                    double epsilon = 0.05);
constexpr int kCoarseLead = 3;
constexpr int kBaseZoom = 6;
std::vector<DemId> planDemRequests(const std::vector<TileId>& tiles, double bearingDeg,
                                   const std::function<bool(const DemId&)>& isLoaded,
                                   const std::function<bool(const DemId&)>& isPending,
                                   int maxRequests);
std::optional<int> bestLoadedDemZoom(const TileId& t,
                                     const std::function<bool(const DemId&)>& isLoaded);

// ---- 3D contours (contours3d.ts) ------------------------------------------------
constexpr int kLevelCount = 7;
constexpr double kLevelLadder[kLevelCount][2] = {{10, 50},   {20, 100},  {25, 100}, {50, 250},
                                                 {100, 500}, {200, 1000}, {500, 2500}};
constexpr double kMinSpacingPx = 5;
constexpr double kMinorWidthPx = 1.1;
constexpr double kMajorWidthPx = 2.0;
std::pair<double, double> contourLevelsForZoom(double zoom);
int baseLevelIndex(double zoom);
std::pair<int, double> levelForDensity(int base, double dhPerPx);
double distanceToLevelPx(double h, double interval, double dhPerPx);
double lineCoverage(double distPx, double widthPx);
bool isMajorLevel(double h, double minor, double major);
std::pair<double, double> contourAt(double h, double dhPerPx, double zoom);

// ---- surface (surface.ts) --------------------------------------------------------
using Rgb = std::array<double, 3>;
struct SurfacePalette {
  Rgb land{}, rock{}, water{}, glacier{}, shadow{}, highlight{};
};
struct SurfaceParams {
  double rockStartM = 2200, rockFullM = 3400, rockMax = 0.35, shadowStrength = 0.62,
         highlightStrength = 0.45, highlightFrom = 0.72, slopeDarken = 0.18;
};
double lambertFor(double slopeX, double slopeY, double exaggeration, const Vec3& light);
Rgb shadeSurface(const SurfacePalette& pal, const SurfaceParams& s, double heightM, double slopeX,
                 double slopeY, double exaggeration, const Vec3& light, double water,
                 double glacier);

// ---- labels (labels.ts) ------------------------------------------------------------
struct LabelInput {
  int id = 0;
  double x = 0, y = 0, h = 0;  // world px, metres
  int kind = 0;
  double priority = 0, w = 0, ph = 0;
};
struct LabelState {
  double opacity = 0, shownAt = -1e300;
};
struct PlacedLabel {
  int id = 0;
  double ax = 0, ay = 0, depth = 0, cx = 0, cy = 0, gx = 0, gy = 0, scale = 1, opacity = 0;
};
struct PlaceOptions {
  Mat4 P{};
  double width = 0, height = 0, ctc = 1, hRef = 0, heightScale = 0;
  double stemPx = 26, padPx = 4, fadeMs = 220, dtMs = 0, nowMs = 0;
  double fadeFromCtc = 7, fadeToCtc = 10;
  int maxLabels = 64;
  std::function<bool(const LabelInput&)> occluded;
};
double labelScale(double distance, double ctc);
bool rectsOverlap(const std::array<double, 4>& a, const std::array<double, 4>& b, double pad);
double stepOpacity(double current, double target, double dtMs, double fadeMs);
bool occludedByTerrain(const Vec3& eye, const Vec3& anchor,
                       const std::function<std::optional<double>(double, double)>& terrainZ,
                       int steps = 24, double clearanceM = 25);
std::vector<PlacedLabel> placeLabels(const std::vector<LabelInput>& inputs,
                                     std::unordered_map<int, LabelState>& states,
                                     const PlaceOptions& o);

// ---- lines / masks (lines.ts) --------------------------------------------------------
using Pt = std::array<double, 2>;
std::vector<Pt> densify(const std::vector<Pt>& pts, double maxStep);
std::array<double, 2> extrudeOffset(const Pt& a, const Pt& b, double side, double widthPx,
                                    const Pt& viewport);
std::vector<uint8_t> rasterizePolygons(const std::vector<std::vector<Pt>>& rings, int size);

}  // namespace inukshuk::terrain
