// Pure terrain math — the C++ twin of src/core/terrain3d (TypeScript is the
// spec; tests/terrain_tests.cpp checks parity against fixtures generated from
// it). No platform or GPU code here.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <limits>
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
  /** lod.ts fogLodFactor: coarser LOD toward the fog (0 = off). */
  double fogStartCtc = 0;
  double fogLodBoost = 0;
  /** Absolute [min, max] (m) known for a tile; nullopt = unknown. */
  std::function<std::optional<std::pair<double, double>>(const TileId&)> heightRange;
  double hRef = 0;
  double heightScale = 1;
};
/** lod.ts fogLodFactor: 1 before the fog start, 1 + boost at the fog end (smoothstep). */
double fogLodFactor(double distance, double fogStartCtc, double fogEndCtc, double boost, double ctc);
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
/**
 * reference.ts stableReferenceHeight: the ground under the map centre (the
 * tilt pivot), raised only when the near terrain would come within the
 * margin (≥ 50 m, ≥ 15 % of the altitude) of the camera.
 */
double stableReferenceHeight(std::optional<double> center, std::optional<double> nearMax,
                             double eyeAltM, double heightScale, double marginM = 50);
/**
 * The 360° base ring (2.2.1): (2·radius+1)² tiles at `zoom` around the mercator
 * point (mx, my), x wrapped (TileId.wrap), y clamped to the world. Their DEMs,
 * meshes and drapes stay pinned so every tile in any direction has an
 * ancestor surface and texture: nothing draws flat or white.
 */
std::vector<TileId> baseRing(double mx, double my, int zoom, int radius = 2);
/** The base ring's zoom: tiles of about half the fog distance, `zoom` − 7 … `zoom` − 2. */
int baseRingZoom(double zoom, double fogDistancePx);
constexpr int kCoarseLead = 3;
/**
 * Every DEM planDemRequests may ask for, in its order (coarse base, coarse
 * lead, own, the neighbours ahead): the engine pins the loaded ones, so a
 * DEM it asked for is never evicted while still wanted (2.2.1).
 */
std::vector<DemId> wantedDems(const std::vector<TileId>& tiles, double bearingDeg);
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
constexpr double kMinSpacingPx = 8;
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
  /** labels.ts: the show/hide decision with hysteresis, and when it lost its place (NaN: has it). */
  bool shown = false;
  double blockedAt = std::numeric_limits<double>::quiet_NaN();
};
constexpr double kLabelHoldMs = 350;
constexpr double kLabelSticky = 1;
constexpr double kLabelEdgeSlackPx = 8;
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
  /** UI bands (px) a plate stays clear of: search/status bar, bottom bar (labels.ts). */
  double topPx = 0, bottomPx = 0;
  /** Show/hide decision flips are added here (round 3 counter); may be null. */
  int* toggles = nullptr;
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

// ---- two-finger gestures (round 3) ----------------------------------------------------
/**
 * What a two-finger gesture is, decided from its first few points and then
 * locked for the rest of it (the platform disables the competing map
 * gestures): tilt (both fingers sliding vertically together, side by side),
 * rotate (the finger line turning), pinch (the spread changing) or a
 * two-finger pan. Undecided until one cue clearly leads.
 */
enum class TwoFingerIntent { Undecided = 0, Tilt = 1, Rotate = 2, Pinch = 3, Pan = 4 };
struct TwoFingerPoints {
  double ax = 0, ay = 0, bx = 0, by = 0;  // the two touches, points (y down)
};
struct TwoFingerThresholds {
  double tiltPx = 14;        // mean vertical travel of both fingers
  double rotateDeg = 10;     // turn of the finger line
  double pinchRatio = 0.10;  // spread change (10 %)
  double panPx = 22;         // centroid travel
  double sideBySideDeg = 50; // a tilt needs the fingers side by side (line within this of horizontal)
  double lead = 1.35;        // the winning cue must lead the next by this factor…
  double decisive = 2.5;     // …unless it is this far past its own threshold
};
TwoFingerIntent classifyTwoFinger(const TwoFingerPoints& start, const TwoFingerPoints& now,
                                  const TwoFingerThresholds& t = {});

// ---- drape textures ----------------------------------------------------------------
/** Mip levels of a size² texture down to 1×1 (size a power of two). */
int mipLevelCount(int size);
/** Bytes of `levels` RGBA8 mip levels starting at size². */
size_t mipChainBytes(int size, int levels);
/**
 * Level 0 (size² RGBA8) followed by every box-filtered mip level down to 1×1,
 * tightly packed — what the renderers upload level by level. `levels` gets the
 * level count. Empty on a bad size.
 */
std::vector<uint8_t> buildMipChain(const uint8_t* rgba, int size, int& levels);

}  // namespace inukshuk::terrain
