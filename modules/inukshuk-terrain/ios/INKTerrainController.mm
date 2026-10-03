// iOS native 3D terrain: an MLNCustomStyleLayer (Metal) drawing a true 3D
// scene straight into MapLibre's own render encoder. See
// docs/plans/native-terrain.md.
//
// The owner's redesign (#551): no draping of the 2D frame. Past the pitch ramp
// the layer — kept on top of the style — draws its own world over the map,
// crossfading in with the ramp: a sky, the terrain as a shaded relief model
// in the theme's palette (or satellite imagery tiles), contour lines evaluated
// per fragment from the surface height, the user's trails lifted onto the
// surface, 3D pin labels and the location marker. Nothing is captured, so the
// layer needs nothing from MapLibre's drawable — it only borrows the encoder
// (and "clears" depth itself with a full-screen draw).
#import "INKTerrainController.h"

#import <CoreLocation/CoreLocation.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "../cpp/terrain_engine.hpp"

using namespace inukshuk::terrain;

// ---- MapLibre, through the runtime ---------------------------------------------

typedef struct {
  double m[16];
} INKMatrix4;  // MLNMatrix4: 16 doubles, MapLibre's column-major order

typedef struct {
  CGSize size;
  CLLocationCoordinate2D centerCoordinate;
  double zoomLevel;
  CLLocationDirection direction;
  CGFloat pitch;
  CGFloat fieldOfView;
  INKMatrix4 projectionMatrix;
  INKMatrix4 nearClippedProjectionMatrix;
} INKDrawingContext;  // MLNStyleLayerDrawingContext (ios-v6.31.0)

@protocol INKMLNCamera <NSObject, NSCopying>
@property(nonatomic) CLLocationCoordinate2D centerCoordinate;
@property(nonatomic) CLLocationDirection heading;
@property(nonatomic) CGFloat pitch;
@property(nonatomic) CLLocationDistance viewingDistance;
@end

@protocol INKMLNStyle <NSObject>
- (nullable id)layerWithIdentifier:(NSString *)identifier;
- (nullable id)sourceWithIdentifier:(NSString *)identifier;
- (void)addLayer:(id)layer;
- (void)removeLayer:(id)layer;
@end

@protocol INKMLNMapView <NSObject>
@property(nonatomic) CGFloat maximumPitch;
@property(nonatomic, assign) double tileLodScale;
@property(nonatomic, assign) double tileLodMinRadius;
@property(nonatomic, copy) id<INKMLNCamera> camera;
@property(nonatomic, readonly, nullable) id<INKMLNStyle> style;
@property(nonatomic) double zoomLevel;
- (void)setCamera:(id<INKMLNCamera>)camera animated:(BOOL)animated;
@end

@protocol INKMLNCustomLayer <NSObject>
- (instancetype)initWithIdentifier:(NSString *)identifier;
- (void)setNeedsDisplay;
@property(nonatomic, weak) id<MTLCommandBuffer> commandBuffer;
@property(nonatomic, weak) MTLRenderPassDescriptor *renderPassDesc;
@property(nonatomic, weak) id<MTLRenderCommandEncoder> renderEncoder;
@end

@protocol INKMLNVectorSource <NSObject>
- (NSArray *)featuresInSourceLayersWithIdentifiers:(NSSet<NSString *> *)ids predicate:(nullable NSPredicate *)p;
@end

@protocol INKMLNFeature <NSObject>
- (nullable id)attributeForKey:(NSString *)key;
@end

@protocol INKMLNShape <NSObject>
@property(nonatomic, readonly) CLLocationCoordinate2D coordinate;
@property(nonatomic, readonly) NSUInteger pointCount;
- (void)getCoordinates:(CLLocationCoordinate2D *)coords range:(NSRange)range;
@property(nonatomic, readonly) NSArray *polygons;
@end

static NSString *const kLayerId = @"inukshuk-terrain-3d";
static char kControllerKey;

@interface INKTerrainController ()
- (void)drawFrame:(const INKDrawingContext &)ctx layer:(id)layer;
@end

static void INKTerrainLayerDraw(id self, SEL _cmd, id mapView, INKDrawingContext ctx) {
  INKTerrainController *c = objc_getAssociatedObject(self, &kControllerKey);
  [c drawFrame:ctx layer:self];
}

static Class INKTerrainLayerClass(void) {
  static Class cls = Nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class base = NSClassFromString(@"MLNCustomStyleLayer");
    if (!base) return;
    SEL sel = NSSelectorFromString(@"drawInMapView:withContext:");
    Method m = class_getInstanceMethod(base, sel);
    if (!m) return;
    Class sub = objc_allocateClassPair(base, "INKTerrainStyleLayer", 0);
    if (!sub) {
      cls = NSClassFromString(@"INKTerrainStyleLayer");
      return;
    }
    class_addMethod(sub, sel, (IMP)INKTerrainLayerDraw, method_getTypeEncoding(m));
    objc_registerClassPair(sub);
    cls = sub;
  });
  return cls;
}

// ---- Metal shaders -----------------------------------------------------------------

static NSString *const kShaderSource = @R"MSL(
#include <metal_stdlib>
using namespace metal;

struct TileU {
  float4x4 matrix;
  float4 a;   // morph, fromFlat, hRef, scale (exaggeration * ramp)
  float4 b;   // skirt (depth * ramp), far, flat (no DEM), -
  float4 ia;  // imagery A: layer, offX, offY, scale
  float4 ib;  // imagery B
  float4 ix;  // blend A→B
};
struct FrameU {
  float4 light;      // xyz, w exaggeration
  float4 fogColor;   // rgb, w ctc
  float4 fogParams;  // start, density, end, ramp
  float4 land;       // rgb, w contour opacity
  float4 rock;       // rgb, w imagery mode
  float4 water;      // rgb, w form strength (imagery)
  float4 glacier;    // rgb, w density (physical px per logical px)
  float4 shadow;     // rgb, w contour base level
  float4 highlight;
  float4 contour;
  float4 contourMajor;
};
struct VIn {
  float3 grid [[attribute(0)]];
  float4 attr [[attribute(1)]];
};
struct VOut {
  float4 position [[position]];
  float2 uv;
  float h;
  float dist;
};

vertex VOut terrain_vs(VIn in [[stage_in]], constant TileU &u [[buffer(2)]]) {
  float to = in.attr.y - u.a.z;
  float from = u.a.y > 0.5 ? 0.0 : in.attr.x - u.a.z;
  float dh = u.b.z > 0.5 ? 0.0 : mix(to, from, u.a.x);
  float z = dh * u.a.w - in.grid.z * u.b.x;
  float4 pos = u.matrix * float4(in.grid.xy, z, 1.0);
  VOut o;
  o.uv = in.grid.xy;
  o.h = u.a.z + dh;
  o.dist = pos.w;
  pos.z = pos.w * pos.w / u.b.y;  // our own linear depth, z_ndc = w / far
  o.position = pos;
  return o;
}

constant float LADDER_MINOR[7] = {10.0, 20.0, 25.0, 50.0, 100.0, 200.0, 500.0};
constant float LADDER_MAJOR[7] = {50.0, 100.0, 100.0, 250.0, 500.0, 1000.0, 2500.0};
constant float MIN_SPACING = 8.0;

static float distPx(float h, float interval, float d) {
  float v = h / interval;
  return abs(v - floor(v + 0.5)) * interval / d;
}
static float cov(float dist, float width) { return clamp(width * 0.5 + 0.5 - dist, 0.0, 1.0); }
static float2 levelCov(float h, float d, int i) {
  float mi = LADDER_MINOR[i];
  float ma = LADDER_MAJOR[i];
  float maj = cov(distPx(h, ma, d), 2.0);
  float k = floor(h / mi + 0.5);
  float every = floor(ma / mi + 0.5);
  bool isMajor = fmod(abs(k), every) == 0.0;
  float mnr = isMajor ? 0.0 : cov(distPx(h, mi, d), 1.1);
  return float2(mnr, maj);
}

fragment float4 terrain_fs(VOut in [[stage_in]], constant FrameU &f [[buffer(0)]],
                           constant TileU &u [[buffer(2)]],
                           texture2d<float> detail [[texture(0)]],
                           texture2d_array<float> imagery [[texture(1)]],
                           sampler s [[sampler(0)]]) {
  float4 det = detail.sample(s, in.uv);
  float2 slope = (det.rg * 2.0 - 1.0) * 4.0;
  float exag = f.light.w;
  float3 n = normalize(float3(-slope * exag, 1.0));
  float lambert = max(dot(n, f.light.xyz), 0.0);
  float flatL = f.light.z;
  float3 c;
  if (f.rock.w > 0.5) {
    float3 b = u.ib.x < 0.0 ? f.fogColor.rgb
                            : imagery.sample(s, u.ib.yz + in.uv * u.ib.w, uint(u.ib.x)).rgb;
    float3 a = u.ia.x < 0.0 ? b : imagery.sample(s, u.ia.yz + in.uv * u.ia.w, uint(u.ia.x)).rgb;
    c = mix(a, b, u.ix.x);
    c *= 1.0 + (lambert - flatL) * f.water.w;
  } else {
    float rock = smoothstep(2200.0, 3400.0, in.h) * 0.35;
    c = mix(f.land.rgb, f.rock.rgb, rock);
    c = mix(c, f.glacier.rgb, det.a);
    float water = max(det.b, in.h <= 0.5 ? 1.0 : 0.0);
    c = mix(c, f.water.rgb, water);
    float away = clamp((flatL - lambert) / max(flatL, 1e-6), 0.0, 1.0);
    float lit = clamp((lambert - 0.72) / 0.28, 0.0, 1.0);
    float grad = length(slope) * exag;
    float steep = smoothstep(0.4, 1.6, grad) * 0.18 * (1.0 - lit);
    c = mix(c, f.shadow.rgb, (1.0 - water) * clamp(away * 0.62 + steep, 0.0, 1.0));
    c = mix(c, f.highlight.rgb, (1.0 - water) * lit * 0.45);
  }
  float contourOpacity = f.land.w;
  if (contourOpacity > 0.0) {
    float d = max(length(float2(dfdx(in.h), dfdy(in.h))) * f.glacier.w, 1e-4);
    int base = int(f.shadow.w + 0.5);
    int idx = 6;
    float finer = 0.0;
    for (int i = 0; i < 7; i++) {
      if (i < base) continue;
      if (LADDER_MINOR[i] / d >= MIN_SPACING) {
        idx = i;
        if (i > base) finer = clamp((LADDER_MINOR[i - 1] / d - (MIN_SPACING - 2.0)) / 2.0, 0.0, 1.0);
        break;
      }
    }
    float2 cc = levelCov(in.h, d, idx);
    if (finer > 0.0) cc = max(cc, levelCov(in.h, d, idx - 1) * finer);
    float fade = 1.0 - smoothstep(0.55, 0.85, in.dist / (f.fogColor.w * f.fogParams.z));
    c = mix(c, f.contour.rgb, cc.x * contourOpacity * 0.75 * fade);  // minors a shade lighter
    c = mix(c, f.contourMajor.rgb, cc.y * contourOpacity * fade);
  }
  float dc = in.dist / f.fogColor.w;
  float fog = dc > f.fogParams.x ? 1.0 - exp(-f.fogParams.y * (dc - f.fogParams.x)) : 0.0;
  float t = clamp((dc - f.fogParams.z * 0.85) / (f.fogParams.z * 0.15), 0.0, 1.0);
  fog = max(fog, t * t * (3.0 - 2.0 * t));
  c = mix(c, f.fogColor.rgb, clamp(fog, 0.0, 1.0));
  return float4(c, f.fogParams.w);
}

struct SkyU {
  float4 rays[3];
  float4 horizon;
  float4 zenith;
  float4 fog;
  float4 misc;  // ramp
};
struct SkyOut {
  float4 position [[position]];
  float4 ray;
};
vertex SkyOut sky_vs(uint vid [[vertex_id]], constant SkyU &u [[buffer(0)]]) {
  SkyOut o;
  o.position = float4(vid == 1 ? 3.0 : -1.0, vid == 2 ? 3.0 : -1.0, 1.0, 1.0);
  o.ray = u.rays[vid];
  return o;
}
fragment float4 sky_fs(SkyOut in [[stage_in]], constant SkyU &u [[buffer(0)]]) {
  float3 d = in.ray.xyz / in.ray.w;
  float e = d.z / max(length(d), 1e-6);
  float3 sky = mix(u.horizon.rgb, u.zenith.rgb, smoothstep(0.0, 0.45, e));
  float3 c = mix(u.fog.rgb, sky, smoothstep(-0.03, 0.01, e));
  return float4(c, u.misc.x);
}

// Depth "clear": MapLibre's 2D depth means nothing to our scene.
vertex float4 clear_vs(uint vid [[vertex_id]]) {
  return float4(vid == 1 ? 3.0 : -1.0, vid == 2 ? 3.0 : -1.0, 1.0, 1.0);
}
fragment float4 clear_fs() { return float4(0.0); }

struct LIn {
  float3 a [[attribute(0)]];
  float3 b [[attribute(1)]];
  float2 se [[attribute(2)]];
};
struct LineU {
  float4x4 m;
  float4 p;     // hRef, scale, far, width (logical px)
  float4 view;  // logical w, h
  float4 color;
};
vertex float4 line_vs(LIn in [[stage_in]], constant LineU &u [[buffer(1)]]) {
  float4 ca = u.m * float4(in.a.xy, (in.a.z - u.p.x) * u.p.y + 2.0, 1.0);
  float4 cb = u.m * float4(in.b.xy, (in.b.z - u.p.x) * u.p.y + 2.0, 1.0);
  float4 c = in.se.y > 0.5 ? cb : ca;
  float2 na = ca.xy / max(ca.w, 1e-6);
  float2 nb = cb.xy / max(cb.w, 1e-6);
  float2 dir = (nb - na) * u.view.xy;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : float2(1.0, 0.0);
  float2 nrm = float2(-dir.y, dir.x);
  float2 off = (nrm * in.se.x + dir * (in.se.y > 0.5 ? 1.0 : -1.0)) * (u.p.w * 0.5);
  c.xy += off / u.view.xy * 2.0 * c.w;
  float w = c.w * 0.996;
  c.z = w * c.w / u.p.z;
  return c;
}
fragment float4 line_fs(float4 pos [[position]], constant LineU &u [[buffer(1)]]) {
  return u.color;
}

struct SIn {
  float2 pos [[attribute(0)]];
  float2 uv [[attribute(1)]];
  float4 color [[attribute(2)]];
  float mode [[attribute(3)]];
};
struct SOut {
  float4 position [[position]];
  float2 uv;
  float4 color;
  float mode;
};
vertex SOut sprite_vs(SIn in [[stage_in]], constant float4 &view [[buffer(1)]]) {
  SOut o;
  o.position = float4(in.pos.x / view.x * 2.0 - 1.0, 1.0 - in.pos.y / view.y * 2.0, 0.0, 1.0);
  o.uv = in.uv;
  o.color = in.color;
  o.mode = in.mode;
  return o;
}
fragment float4 sprite_fs(SOut in [[stage_in]], texture2d<float> atlas [[texture(0)]],
                          sampler s [[sampler(0)]]) {
  if (in.mode < 0.5) return atlas.sample(s, in.uv) * in.color.a;
  if (in.mode < 1.5) return float4(in.color.rgb * in.color.a, in.color.a);
  float2 q = in.uv * 2.0 - 1.0;
  float r = length(q);
  float aa = fwidth(r);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  float3 col = in.color.rgb;
  if (in.mode > 2.5) col = mix(in.color.rgb, float3(1.0), smoothstep(0.62 - aa, 0.62, r));
  float a = disc * in.color.a;
  return float4(col * a, a);
}
)MSL";

struct TileU {
  simd_float4x4 matrix;
  simd_float4 a, b, ia, ib, ix;
};
struct FrameU {
  simd_float4 light, fogColor, fogParams, land, rock, water, glacier, shadow, highlight, contour,
      contourMajor;
};
struct SkyU {
  simd_float4 rays[3];
  simd_float4 horizon, zenith, fog, misc;
};
struct LineU {
  simd_float4x4 m;
  simd_float4 p, view, color;
};

static simd_float4 f4(const float *c, float w) { return simd_make_float4(c[0], c[1], c[2], w); }
static simd_float4x4 mat(const float *m) {
  simd_float4x4 r;
  for (int c = 0; c < 4; c++) r.columns[c] = simd_make_float4(m[c * 4], m[c * 4 + 1], m[c * 4 + 2], m[c * 4 + 3]);
  return r;
}

// ---- label sprites --------------------------------------------------------------

namespace {

struct Shelf {
  int size = 2048, shelfY = 0, shelfH = 0, cursorX = 0;
  struct R {
    int x, y, w, h;
  };
  std::unordered_map<std::string, R> rects;
  void reset() {
    rects.clear();
    shelfY = shelfH = cursorX = 0;
  }
  bool allocate(const std::string &key, int w, int h, R &out) {
    auto it = rects.find(key);
    if (it != rects.end() && it->second.w == w && it->second.h == h) {
      out = it->second;
      return true;
    }
    if (w > size || h > size) return false;
    if (cursorX + w > size) {
      shelfY += shelfH + 1;
      shelfH = 0;
      cursorX = 0;
    }
    if (shelfY + h > size) return false;
    out = {cursorX, shelfY, w, h};
    cursorX += w + 1;
    shelfH = std::max(shelfH, h);
    rects[key] = out;
    return true;
  }
};

struct SpriteUpload {
  int x, y, w, h;
  std::vector<uint8_t> rgba;
};

struct Candidate {
  std::string key;
  int kind;
  double lng, lat, priority;
  NSString *title;
  NSString *sub;
  bool major;
};

struct GpuTile {
  id<MTLBuffer> buffer;
  id<MTLTexture> detail;
  uint32_t version = 0;
  uint64_t lastFrame = 0;
};

struct GpuLine {
  id<MTLBuffer> buffer;
  uint32_t version = 0;
  NSUInteger count = 0;
  uint64_t lastFrame = 0;
};

constexpr int kAtlasSize = 2048;
constexpr int kMaxLabels = 220;
constexpr size_t kMaxMaskPoints = 60000;

double mercX(double lng) { return (lng + 180.0) / 360.0; }
double mercY(double lat) {
  const double l = std::max(-85.05112878, std::min(85.05112878, lat)) * M_PI / 180.0;
  return 0.5 - std::log(std::tan(M_PI / 4 + l / 2)) / (2 * M_PI);
}

}  // namespace

// ---- the controller -------------------------------------------------------------------

@implementation INKTerrainController {
  __weak UIView *_mapView;
  id _layer;
  std::unique_ptr<Engine> _engine;
  std::atomic<bool> _enabled;
  std::atomic<bool> _detached;
  double _maxPitch;
  double _defaultLodScale, _defaultLodMinRadius;
  std::atomic<bool> _networkAllowed;
  NSURLSession *_session;
  NSString *_cacheDir, *_imageryDir;
  NSTimer *_watcher;
  id _memoryObserver;
  // Metal
  id<MTLDevice> _device;
  id<MTLLibrary> _library;
  MTLPixelFormat _colorFormat, _depthFormat, _stencilFormat;
  NSUInteger _sampleCount;
  id<MTLRenderPipelineState> _terrainPipeline, _skyPipeline, _clearPipeline, _linePipeline, _spritePipeline;
  id<MTLDepthStencilState> _depthLess, _depthOff, _depthAlways, _depthTest;
  id<MTLSamplerState> _sampler;
  id<MTLBuffer> _gridBuffer, _indexBuffer, _zeroBuffer;
  NSUInteger _indexCount;
  id<MTLTexture> _flatDetail, _flatImagery, _imagery, _atlas;
  std::unordered_map<uint64_t, GpuTile> _tiles;
  std::unordered_map<int, GpuLine> _lines;
  id<MTLBuffer> _spriteBuffers[3];
  int _spriteIndex;
  std::vector<float> _spriteVerts;
  uint64_t _frameNo;
  // scene (labels, masks)
  dispatch_queue_t _sceneQueue;
  std::mutex _spriteMutex;
  std::vector<SpriteUpload> _spriteUploads;
  float _labelInk[3];
  NSArray<NSNumber *> *_labelTheme;
  NSArray<NSString *> *_nameFields;
  BOOL _labelsEnabled;
  Shelf _shelf;            // scene queue only
  std::string _themeKey;   // scene queue only
  uint64_t _lastLabelHash, _lastMaskHash;  // scene queue only
  NSString *_lastSceneCamera;
  int _watchTicks, _ticksSinceScene;
  std::unordered_set<int> _lineIds;
  UIFont *_regular, *_bold;
  // recording
  std::mutex _timesMutex;
  std::vector<int64_t> _frameTimes, _costs;
  std::atomic<bool> _recording;
  double _lastDrawMs;
  double _lastPitchDeg;
  int _drawnTiles;
  // bench
  CADisplayLink *_benchLink;
  NSMutableArray<NSDictionary *> *_benchSteps;
  NSDictionary *_benchStep;
  CFTimeInterval _benchStepStart;
  id<INKMLNCamera> _benchBase;
  void (^_benchDone)(void);
}

+ (UIView *)findMapViewIn:(UIView *)host {
  Class mln = NSClassFromString(@"MLNMapView");
  if (!mln) return nil;
  if ([host isKindOfClass:mln]) return host;
  for (UIView *sub in host.subviews) {
    UIView *found = [self findMapViewIn:sub];
    if (found) return found;
  }
  return nil;
}

static int64_t nowNs() { return (int64_t)(CACurrentMediaTime() * 1e9); }

- (instancetype)initWithMapView:(UIView *)mapView {
  if (!(self = [super init])) return nil;
  if (!INKTerrainLayerClass()) return nil;
  _mapView = mapView;
  _enabled = true;
  _detached = false;
  _recording = false;
  _maxPitch = 80;
  _networkAllowed = true;
  _labelsEnabled = YES;
  _nameFields = @[ @"name" ];
  _labelInk[0] = 0.18f;
  _labelInk[1] = 0.16f;
  _labelInk[2] = 0.13f;
  MTKView *mtk = nil;
  for (UIView *sub in mapView.subviews) {
    if ([sub isKindOfClass:[MTKView class]]) {
      mtk = (MTKView *)sub;
      break;
    }
  }
  _device = mtk.device ?: MTLCreateSystemDefaultDevice();
  if (!_device || ![self buildResources]) return nil;
  _regular = [self atkinson:UIFontWeightRegular size:12];
  _bold = [self atkinson:UIFontWeightBold size:12];
  _sceneQueue = dispatch_queue_create("inukshuk.terrain.labels", DISPATCH_QUEUE_SERIAL);

  NSString *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  _cacheDir = [caches stringByAppendingPathComponent:@"dem"];
  _imageryDir = [caches stringByAppendingPathComponent:@"terrain-imagery"];
  [[NSFileManager defaultManager] createDirectoryAtPath:_cacheDir withIntermediateDirectories:YES attributes:nil error:nil];
  [[NSFileManager defaultManager] createDirectoryAtPath:_imageryDir withIntermediateDirectories:YES attributes:nil error:nil];
  NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  cfg.timeoutIntervalForRequest = 15;
  cfg.HTTPMaximumConnectionsPerHost = 6;
  cfg.HTTPAdditionalHeaders = @{@"User-Agent" : @"Inukshuk/1.0 (offline trail navigation app)"};
  NSOperationQueue *q = [NSOperationQueue new];
  q.maxConcurrentOperationCount = 4;
  q.qualityOfService = NSQualityOfServiceUtility;
  _session = [NSURLSession sessionWithConfiguration:cfg delegate:nil delegateQueue:q];

  __weak INKTerrainController *weakSelf = self;
  _engine = std::make_unique<Engine>(
      [weakSelf](int z, int x, int y) { [weakSelf fetchDemZ:z x:x y:y]; },
      [weakSelf](int z, int x, int y) { [weakSelf fetchImageryZ:z x:x y:y]; },
      [weakSelf] {
        dispatch_async(dispatch_get_main_queue(), ^{
          [weakSelf requestRepaint];
        });
      });
  return self;
}

- (UIFont *)atkinson:(UIFontWeight)weight size:(CGFloat)size {
  UIFontDescriptor *d = [UIFontDescriptor fontDescriptorWithFontAttributes:@{
    UIFontDescriptorFamilyAttribute : @"Atkinson Hyperlegible Next",
    UIFontDescriptorTraitsAttribute : @{UIFontWeightTrait : @(weight)},
  }];
  UIFont *f = [UIFont fontWithDescriptor:d size:size];
  if (f && [f.familyName hasPrefix:@"Atkinson"]) return f;
  return [UIFont systemFontOfSize:size weight:weight];
}

- (BOOL)buildResources {
  NSError *err = nil;
  _library = [_device newLibraryWithSource:kShaderSource options:nil error:&err];
  if (!_library) {
    NSLog(@"[InukshukTerrain] shader compile failed: %@", err);
    return NO;
  }
  MTLDepthStencilDescriptor *dl = [MTLDepthStencilDescriptor new];
  dl.depthCompareFunction = MTLCompareFunctionLess;
  dl.depthWriteEnabled = YES;
  _depthLess = [_device newDepthStencilStateWithDescriptor:dl];
  MTLDepthStencilDescriptor *dt = [MTLDepthStencilDescriptor new];
  dt.depthCompareFunction = MTLCompareFunctionLessEqual;
  dt.depthWriteEnabled = NO;
  _depthTest = [_device newDepthStencilStateWithDescriptor:dt];
  MTLDepthStencilDescriptor *doff = [MTLDepthStencilDescriptor new];
  doff.depthCompareFunction = MTLCompareFunctionAlways;
  doff.depthWriteEnabled = NO;
  _depthOff = [_device newDepthStencilStateWithDescriptor:doff];
  MTLDepthStencilDescriptor *da = [MTLDepthStencilDescriptor new];
  da.depthCompareFunction = MTLCompareFunctionAlways;
  da.depthWriteEnabled = YES;
  _depthAlways = [_device newDepthStencilStateWithDescriptor:da];
  MTLSamplerDescriptor *smp = [MTLSamplerDescriptor new];
  smp.minFilter = MTLSamplerMinMagFilterLinear;
  smp.magFilter = MTLSamplerMinMagFilterLinear;
  smp.sAddressMode = MTLSamplerAddressModeClampToEdge;
  smp.tAddressMode = MTLSamplerAddressModeClampToEdge;
  _sampler = [_device newSamplerStateWithDescriptor:smp];

  const auto verts = buildGridVertices(kGrid);
  const auto idx32 = buildGridIndices(kGrid);
  std::vector<uint16_t> idx(idx32.begin(), idx32.end());
  _indexCount = idx.size();
  _gridBuffer = [_device newBufferWithBytes:verts.data() length:verts.size() * sizeof(float) options:MTLResourceStorageModeShared];
  _indexBuffer = [_device newBufferWithBytes:idx.data() length:idx.size() * sizeof(uint16_t) options:MTLResourceStorageModeShared];
  std::vector<float> zeros((size_t)vertexCount(kGrid) * kAttributesPerVertex, 0.f);
  _zeroBuffer = [_device newBufferWithBytes:zeros.data() length:zeros.size() * sizeof(float) options:MTLResourceStorageModeShared];

  MTLTextureDescriptor *fd = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:1 height:1 mipmapped:NO];
  _flatDetail = [_device newTextureWithDescriptor:fd];
  const uint8_t flatPx[4] = {128, 128, 0, 0};
  [_flatDetail replaceRegion:MTLRegionMake2D(0, 0, 1, 1) mipmapLevel:0 withBytes:flatPx bytesPerRow:4];
  MTLTextureDescriptor *fi = [MTLTextureDescriptor new];
  fi.textureType = MTLTextureType2DArray;
  fi.pixelFormat = MTLPixelFormatRGBA8Unorm;
  fi.width = 1;
  fi.height = 1;
  fi.arrayLength = 1;
  _flatImagery = [_device newTextureWithDescriptor:fi];
  MTLTextureDescriptor *ad = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:kAtlasSize height:kAtlasSize mipmapped:NO];
  _atlas = [_device newTextureWithDescriptor:ad];
  return YES;
}

/** Pipelines match MapLibre's pass (formats, MSAA); rebuilt if it changes. */
- (BOOL)ensurePipelinesFor:(MTLRenderPassDescriptor *)rp {
  id<MTLTexture> color = rp.colorAttachments[0].texture;
  if (!color) return NO;
  const MTLPixelFormat cf = color.pixelFormat;
  const MTLPixelFormat df = rp.depthAttachment.texture ? rp.depthAttachment.texture.pixelFormat : MTLPixelFormatInvalid;
  const MTLPixelFormat sf = rp.stencilAttachment.texture ? rp.stencilAttachment.texture.pixelFormat : MTLPixelFormatInvalid;
  const NSUInteger sc = color.sampleCount;
  if (_terrainPipeline && cf == _colorFormat && df == _depthFormat && sf == _stencilFormat && sc == _sampleCount) return YES;
  if (df == MTLPixelFormatInvalid) return NO;  // no depth attachment: nothing sensible to draw
  _colorFormat = cf;
  _depthFormat = df;
  _stencilFormat = sf;
  _sampleCount = sc;
  NSError *err = nil;
  auto base = ^MTLRenderPipelineDescriptor *(NSString *vs, NSString *fs) {
    MTLRenderPipelineDescriptor *pd = [MTLRenderPipelineDescriptor new];
    pd.vertexFunction = [self->_library newFunctionWithName:vs];
    pd.fragmentFunction = [self->_library newFunctionWithName:fs];
    pd.colorAttachments[0].pixelFormat = cf;
    pd.depthAttachmentPixelFormat = df;
    pd.stencilAttachmentPixelFormat = sf;
    pd.rasterSampleCount = sc;
    return pd;
  };
  auto alphaBlend = ^(MTLRenderPipelineDescriptor *pd, BOOL premultiplied) {
    pd.colorAttachments[0].blendingEnabled = YES;
    pd.colorAttachments[0].sourceRGBBlendFactor = premultiplied ? MTLBlendFactorOne : MTLBlendFactorSourceAlpha;
    pd.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
    pd.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorZero;
    pd.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOne;
  };

  MTLVertexDescriptor *vd = [MTLVertexDescriptor vertexDescriptor];
  vd.attributes[0].format = MTLVertexFormatFloat3;
  vd.attributes[0].bufferIndex = 0;
  vd.attributes[1].format = MTLVertexFormatFloat4;
  vd.attributes[1].bufferIndex = 1;
  vd.layouts[0].stride = 3 * sizeof(float);
  vd.layouts[1].stride = 4 * sizeof(float);
  MTLRenderPipelineDescriptor *tp = base(@"terrain_vs", @"terrain_fs");
  tp.vertexDescriptor = vd;
  alphaBlend(tp, NO);
  _terrainPipeline = [_device newRenderPipelineStateWithDescriptor:tp error:&err];

  MTLRenderPipelineDescriptor *sp = base(@"sky_vs", @"sky_fs");
  alphaBlend(sp, NO);
  _skyPipeline = [_device newRenderPipelineStateWithDescriptor:sp error:&err];

  MTLRenderPipelineDescriptor *cp = base(@"clear_vs", @"clear_fs");
  cp.colorAttachments[0].writeMask = MTLColorWriteMaskNone;
  _clearPipeline = [_device newRenderPipelineStateWithDescriptor:cp error:&err];

  MTLVertexDescriptor *lv = [MTLVertexDescriptor vertexDescriptor];
  lv.attributes[0].format = MTLVertexFormatFloat3;
  lv.attributes[0].offset = 0;
  lv.attributes[1].format = MTLVertexFormatFloat3;
  lv.attributes[1].offset = 12;
  lv.attributes[2].format = MTLVertexFormatFloat2;
  lv.attributes[2].offset = 24;
  for (int i = 0; i < 3; i++) lv.attributes[i].bufferIndex = 0;
  lv.layouts[0].stride = 8 * sizeof(float);
  MTLRenderPipelineDescriptor *lp = base(@"line_vs", @"line_fs");
  lp.vertexDescriptor = lv;
  alphaBlend(lp, NO);
  _linePipeline = [_device newRenderPipelineStateWithDescriptor:lp error:&err];

  MTLVertexDescriptor *sv = [MTLVertexDescriptor vertexDescriptor];
  sv.attributes[0].format = MTLVertexFormatFloat2;
  sv.attributes[0].offset = 0;
  sv.attributes[1].format = MTLVertexFormatFloat2;
  sv.attributes[1].offset = 8;
  sv.attributes[2].format = MTLVertexFormatFloat4;
  sv.attributes[2].offset = 16;
  sv.attributes[3].format = MTLVertexFormatFloat;
  sv.attributes[3].offset = 32;
  for (int i = 0; i < 4; i++) sv.attributes[i].bufferIndex = 0;
  sv.layouts[0].stride = 9 * sizeof(float);
  MTLRenderPipelineDescriptor *pp = base(@"sprite_vs", @"sprite_fs");
  pp.vertexDescriptor = sv;
  alphaBlend(pp, YES);
  _spritePipeline = [_device newRenderPipelineStateWithDescriptor:pp error:&err];

  if (!_terrainPipeline || !_skyPipeline || !_clearPipeline || !_linePipeline || !_spritePipeline) {
    NSLog(@"[InukshukTerrain] pipeline failed: %@", err);
    _terrainPipeline = nil;
    return NO;
  }
  return YES;
}

// ---- lifecycle ----------------------------------------------------------------------------

static LookParams lookFrom(NSArray<NSNumber *> *a) {
  std::vector<float> v;
  v.reserve(a.count);
  for (NSNumber *n in a) v.push_back(n.floatValue);
  return lookFromFloats(v.data(), (int)v.size());
}

- (BOOL)attachWithLook:(NSArray<NSNumber *> *)look
               enabled:(BOOL)enabled
        networkAllowed:(BOOL)networkAllowed
              maxPitch:(double)maxPitch {
  _maxPitch = maxPitch;
  id<INKMLNMapView> m = (id<INKMLNMapView>)_mapView;
  _defaultLodScale = m.tileLodScale;
  _defaultLodMinRadius = m.tileLodMinRadius;
  [self updateWithLook:look enabled:enabled networkAllowed:networkAllowed];
  [self ensureLayer];
  __weak INKTerrainController *weakSelf = self;
  _watcher = [NSTimer scheduledTimerWithTimeInterval:0.4
                                             repeats:YES
                                               block:^(NSTimer *t) {
                                                 [weakSelf tick];
                                               }];
  _memoryObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidReceiveMemoryWarningNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *n) {
                [weakSelf trimMemory];
              }];
  return YES;
}

- (void)updateWithLook:(NSArray<NSNumber *> *)look enabled:(BOOL)enabled networkAllowed:(BOOL)networkAllowed {
  _engine->setLook(lookFrom(look));
  _enabled = enabled;
  _networkAllowed = networkAllowed;
  id<INKMLNMapView> map = (id<INKMLNMapView>)_mapView;
  if (map) {
    map.maximumPitch = enabled ? _maxPitch : 60;
    // In 3D the far band is fog: let MapLibre's pitch LOD coarsen it sooner.
    map.tileLodScale = enabled ? 1.6 : _defaultLodScale;
    map.tileLodMinRadius = enabled ? 2.0 : _defaultLodMinRadius;
  }
  [self requestRepaint];
}

- (void)setLabelTheme:(NSArray<NSNumber *> *)theme nameFields:(NSArray<NSString *> *)nameFields labels:(BOOL)labels {
  const BOOL changed = ![theme isEqualToArray:_labelTheme ?: @[]] || ![nameFields isEqualToArray:_nameFields] || labels != _labelsEnabled;
  _labelTheme = [theme copy];
  _nameFields = nameFields.count ? [nameFields copy] : @[ @"name" ];
  _labelsEnabled = labels;
  if (theme.count >= 7) {
    std::lock_guard<std::mutex> lock(_spriteMutex);
    for (int i = 0; i < 3; i++) _labelInk[i] = theme[4 + i].floatValue;
  }
  if (changed) [self refreshScene:YES];
}

- (void)setLines:(NSArray<NSDictionary *> *)lines {
  if (_detached.load()) return;
  std::unordered_set<int> keep;
  for (NSDictionary *l in lines) {
    const int lid = [l[@"id"] intValue];
    NSArray<NSNumber *> *coords = l[@"coords"];
    NSArray<NSNumber *> *style = l[@"style"];
    std::vector<Pt> pts;
    pts.reserve(coords.count / 2);
    for (NSUInteger i = 0; i + 1 < coords.count; i += 2) {
      pts.push_back({mercX(coords[i].doubleValue), mercY(coords[i + 1].doubleValue)});
    }
    LineStyle ls;
    if (style.count >= 11) {
      for (int i = 0; i < 4; i++) {
        ls.color[i] = style[i].floatValue;
        ls.halo[i] = style[4 + i].floatValue;
      }
      ls.width = style[8].floatValue;
      ls.haloWidth = style[9].floatValue;
      ls.order = style[10].intValue;
    }
    keep.insert(lid);
    _engine->setPolyline(lid, std::move(pts), ls);
  }
  for (int lid : _lineIds)
    if (!keep.count(lid)) _engine->removePolyline(lid);
  _lineIds = keep;
}

- (void)setPuckVisible:(BOOL)visible lng:(double)lng lat:(double)lat {
  if (_detached.load()) return;
  _engine->setPuck(visible, mercX(lng), mercY(lat));
}

- (void)detach {
  if (_detached.exchange(true)) return;
  _enabled = false;
  [_watcher invalidate];
  _watcher = nil;
  [_benchLink invalidate];
  _benchLink = nil;
  if (_memoryObserver) [[NSNotificationCenter defaultCenter] removeObserver:_memoryObserver];
  _memoryObserver = nil;
  id<INKMLNMapView> map = (id<INKMLNMapView>)_mapView;
  if (map) {
    map.maximumPitch = 60;
    map.tileLodScale = _defaultLodScale;
    map.tileLodMinRadius = _defaultLodMinRadius;
    id<INKMLNCamera> cam = [map.camera copyWithZone:nil];
    if (cam.pitch > 60) {
      cam.pitch = 60;
      [map setCamera:cam animated:NO];
    }
  }
  if (_layer) {
    objc_setAssociatedObject(_layer, &kControllerKey, nil, OBJC_ASSOCIATION_ASSIGN);
    id<INKMLNStyle> style = map.style;
    if (style && [style layerWithIdentifier:kLayerId]) [style removeLayer:_layer];
    _layer = nil;
  }
  [_session invalidateAndCancel];
  _tiles.clear();
  _lines.clear();
}

- (void)dealloc {
  [self detach];
}

- (void)tick {
  [self ensureLayer];
  _ticksSinceScene++;
  if (++_watchTicks % 3 == 0) [self refreshScene:_ticksSinceScene >= 10];
}

- (void)ensureLayer {
  if (_detached.load()) return;
  id<INKMLNMapView> map = (id<INKMLNMapView>)_mapView;
  id<INKMLNStyle> style = map.style;
  if (!style) return;
  if (_layer && [style layerWithIdentifier:kLayerId] == _layer) {
    // RN re-inserts its component layers after style loads: stay on top.
    NSArray *layers = [(id)style valueForKey:@"layers"];
    if (layers.lastObject == _layer) return;
    [style removeLayer:_layer];
    [style addLayer:_layer];
    return;
  }
  if (id old = [style layerWithIdentifier:kLayerId]) [style removeLayer:old];
  id layer = [(id<INKMLNCustomLayer>)[INKTerrainLayerClass() alloc] initWithIdentifier:kLayerId];
  if (!layer) return;
  objc_setAssociatedObject(layer, &kControllerKey, self, OBJC_ASSOCIATION_ASSIGN);
  [style addLayer:layer];
  _layer = layer;
}

- (void)requestRepaint {
  if (_detached.load() || !_layer) return;
  [(id<INKMLNCustomLayer>)_layer setNeedsDisplay];
}

// ---- DEM + imagery fetching ------------------------------------------------------------------

- (void)fetchDemZ:(int)z x:(int)x y:(int)y {
  NSString *path = [_cacheDir stringByAppendingPathComponent:[NSString stringWithFormat:@"dem-%d-%d-%d.png", z, x, y]];
  __weak INKTerrainController *weakSelf = self;
  NSOperationQueue *q = _session.delegateQueue;
  const bool net = _networkAllowed.load();
  [q addOperationWithBlock:^{
    INKTerrainController *s = weakSelf;
    if (!s || s->_detached.load()) return;
    NSData *cached = [NSData dataWithContentsOfFile:path];
    if (cached.length > 8) {
      if (s->_engine->onDemData(z, x, y, (const uint8_t *)cached.bytes, cached.length)) return;
      [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    }
    if (!net) {
      s->_engine->onDemFailed(z, x, y);
      return;
    }
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png", z, x, y]];
    NSURLSessionDataTask *task = [s->_session
          dataTaskWithURL:url
        completionHandler:^(NSData *data, NSURLResponse *resp, NSError *error) {
          INKTerrainController *s2 = weakSelf;
          if (!s2 || s2->_detached.load()) return;
          NSInteger code = [resp isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)resp).statusCode : 0;
          if (error || code != 200 || data.length < 9 || ((const uint8_t *)data.bytes)[0] != 0x89) {
            s2->_engine->onDemFailed(z, x, y);
            return;
          }
          NSString *tmp = [path stringByAppendingFormat:@".%u.tmp", arc4random()];
          if ([data writeToFile:tmp atomically:NO]) {
            [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
            [[NSFileManager defaultManager] moveItemAtPath:tmp toPath:path error:nil];
          }
          s2->_engine->onDemData(z, x, y, (const uint8_t *)data.bytes, data.length);
        }];
    [task resume];
  }];
}

static std::vector<uint8_t> decodeImagery(NSData *data) {
  UIImage *img = [UIImage imageWithData:data];
  CGImageRef cg = img.CGImage;
  if (!cg) return {};
  std::vector<uint8_t> px((size_t)kImagerySize * kImagerySize * 4);
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(px.data(), kImagerySize, kImagerySize, 8, kImagerySize * 4, cs,
                                           kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(cs);
  if (!ctx) return {};
  CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
  CGContextDrawImage(ctx, CGRectMake(0, 0, kImagerySize, kImagerySize), cg);
  CGContextRelease(ctx);
  return px;
}

- (void)fetchImageryZ:(int)z x:(int)x y:(int)y {
  NSString *path = [_imageryDir stringByAppendingPathComponent:[NSString stringWithFormat:@"img-%d-%d-%d.jpg", z, x, y]];
  __weak INKTerrainController *weakSelf = self;
  NSOperationQueue *q = _session.delegateQueue;
  const bool net = _networkAllowed.load();
  [q addOperationWithBlock:^{
    INKTerrainController *s = weakSelf;
    if (!s || s->_detached.load()) return;
    NSData *cached = [NSData dataWithContentsOfFile:path];
    if (cached.length > 0) {
      auto px = decodeImagery(cached);
      if (!px.empty()) {
        s->_engine->onImageryData(z, x, y, std::move(px));
        return;
      }
    }
    if (!net) {
      s->_engine->onImageryFailed(z, x, y);
      return;
    }
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/%d/%d/%d", z, y, x]];
    NSURLSessionDataTask *task = [s->_session
          dataTaskWithURL:url
        completionHandler:^(NSData *data, NSURLResponse *resp, NSError *error) {
          INKTerrainController *s2 = weakSelf;
          if (!s2 || s2->_detached.load()) return;
          NSInteger code = [resp isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)resp).statusCode : 0;
          auto px = (error || code != 200) ? std::vector<uint8_t>() : decodeImagery(data);
          if (px.empty()) {
            s2->_engine->onImageryFailed(z, x, y);
            return;
          }
          [data writeToFile:path atomically:YES];
          s2->_engine->onImageryData(z, x, y, std::move(px));
        }];
    [task resume];
  }];
}

// ---- scene: labels and masks from the loaded vector tiles -------------------------------------

- (NSString *)nameOf:(id<INKMLNFeature>)f {
  for (NSString *k in _nameFields) {
    id v = [f attributeForKey:k];
    if ([v isKindOfClass:[NSString class]] && [(NSString *)v length]) return v;
  }
  id v = [f attributeForKey:@"name"];
  return [v isKindOfClass:[NSString class]] && [(NSString *)v length] ? v : nil;
}

static double numAttr(id<INKMLNFeature> f, NSString *k, double fallback, bool *has = nullptr) {
  id v = [f attributeForKey:k];
  if ([v isKindOfClass:[NSNumber class]]) {
    if (has) *has = true;
    return [v doubleValue];
  }
  if (has) *has = false;
  return fallback;
}

static NSString *strAttr(id<INKMLNFeature> f, NSString *k) {
  id v = [f attributeForKey:k];
  return [v isKindOfClass:[NSString class]] ? v : nil;
}

static BOOL isPoint(id f) { return [f isKindOfClass:NSClassFromString(@"MLNPointFeature")]; }

- (void)refreshScene:(BOOL)force {
  if (_detached.load() || !_enabled.load()) return;
  id<INKMLNMapView> map = (id<INKMLNMapView>)_mapView;
  id<INKMLNCamera> cam = map.camera;
  if (!cam || cam.pitch < 20) return;
  NSString *key = [NSString stringWithFormat:@"%.6f,%.6f,%.3f,%.1f", cam.centerCoordinate.latitude,
                                             cam.centerCoordinate.longitude, map.zoomLevel, cam.heading];
  if (!force && [key isEqualToString:_lastSceneCamera]) return;
  _lastSceneCamera = key;
  _ticksSinceScene = 0;
  id<INKMLNStyle> style = map.style;
  if (!style) return;
  id base = [style sourceWithIdentifier:@"basemap-vector"];
  id peaks = [style sourceWithIdentifier:@"basemap-peaks"];
  SEL q = @selector(featuresInSourceLayersWithIdentifiers:predicate:);
  if (base && ![base respondsToSelector:q]) base = nil;
  if (peaks && ![peaks respondsToSelector:q]) peaks = nil;

  auto cands = std::make_shared<std::vector<Candidate>>();
  if (_labelsEnabled) {
    NSArray *peakFeatures = peaks ? [(id<INKMLNVectorSource>)peaks featuresInSourceLayersWithIdentifiers:[NSSet setWithObject:@"peaks"] predicate:nil]
                                  : (base ? [(id<INKMLNVectorSource>)base featuresInSourceLayersWithIdentifiers:[NSSet setWithObject:@"pois"]
                                                                                                    predicate:[NSPredicate predicateWithFormat:@"kind IN {'peak', 'volcano'}"]]
                                          : @[]);
    for (id f in peakFeatures) {
      if (!isPoint(f)) continue;
      NSString *name = [self nameOf:f];
      if (!name) continue;
      bool hasEle = false, hasRank = false;
      const double ele = numAttr(f, peaks ? @"ele" : @"elevation", 0, &hasEle);
      const double rank = peaks ? numAttr(f, @"rank", 0, &hasRank) : 0;
      double pr;
      if (hasRank) {
        pr = ele >= 5000 ? -15.0 - std::floor(ele / 1000) : ele >= 4000 ? -std::floor(ele / 250) : rank;
      } else {
        pr = 12.0 - std::floor(ele / 500) / 10;
      }
      const CLLocationCoordinate2D c = [(id<INKMLNShape>)f coordinate];
      NSString *sub = hasEle ? [NSString stringWithFormat:@"%ld m", lround(ele)] : nil;
      cands->push_back({std::string("p|") + name.UTF8String + "|" + std::to_string(lround(c.latitude * 1e3)), 0,
                        c.longitude, c.latitude, pr, name, sub, pr < 6});
    }
    if (base) {
      id<INKMLNVectorSource> src = base;
      for (id f in [src featuresInSourceLayersWithIdentifiers:[NSSet setWithObject:@"places"] predicate:nil]) {
        if (!isPoint(f)) continue;
        NSString *name = [self nameOf:f];
        if (!name || ![strAttr(f, @"kind") isEqualToString:@"locality"]) continue;
        NSString *detail = strAttr(f, @"kind_detail");
        if ([detail isEqualToString:@"neighbourhood"] || [detail isEqualToString:@"suburb"]) continue;
        const double mz = numAttr(f, @"min_zoom", 14);
        const double bonus = [detail isEqualToString:@"city"] ? -1 : [detail isEqualToString:@"town"] ? -0.5 : 0;
        const CLLocationCoordinate2D c = [(id<INKMLNShape>)f coordinate];
        cands->push_back({std::string("c|") + name.UTF8String, 1, c.longitude, c.latitude, mz + bonus, name, nil,
                          [detail isEqualToString:@"city"] || [detail isEqualToString:@"town"]});
      }
      NSSet *poiKinds = [NSSet setWithArray:@[ @"alpine_hut", @"wilderness_hut", @"shelter", @"viewpoint", @"saddle", @"mountain_pass", @"camp_site" ]];
      for (id f in [src featuresInSourceLayersWithIdentifiers:[NSSet setWithObject:@"pois"] predicate:nil]) {
        if (!isPoint(f)) continue;
        NSString *kind = strAttr(f, @"kind");
        if (!kind || ![poiKinds containsObject:kind]) continue;
        NSString *name = [self nameOf:f];
        if (!name) continue;
        const CLLocationCoordinate2D c = [(id<INKMLNShape>)f coordinate];
        cands->push_back({std::string("i|") + name.UTF8String + "|" + std::to_string(lround(c.latitude * 1e3)), 2,
                          c.longitude, c.latitude, 14.0 + numAttr(f, @"min_zoom", 15) / 10, name, nil, false});
      }
      for (id f in [src featuresInSourceLayersWithIdentifiers:[NSSet setWithObject:@"water"] predicate:nil]) {
        if (!isPoint(f)) continue;
        NSString *kind = strAttr(f, @"kind");
        if (!([kind isEqualToString:@"lake"] || [kind isEqualToString:@"water"] || [kind isEqualToString:@"reservoir"])) continue;
        NSString *name = [self nameOf:f];
        if (!name) continue;
        const CLLocationCoordinate2D c = [(id<INKMLNShape>)f coordinate];
        cands->push_back({std::string("w|") + name.UTF8String, 3, c.longitude, c.latitude,
                          12.0 + numAttr(f, @"min_zoom", 14) / 4, name, nil, false});
      }
    }
  }
  // Masks: outer rings of water and glacier polygons.
  auto water = std::make_shared<std::vector<std::vector<Pt>>>();
  auto ice = std::make_shared<std::vector<std::vector<Pt>>>();
  if (base) {
    auto collect = ^(NSArray *features, std::vector<std::vector<Pt>> *out) {
      Class poly = NSClassFromString(@"MLNPolygonFeature");
      Class multi = NSClassFromString(@"MLNMultiPolygonFeature");
      auto addRing = [out](id<INKMLNShape> p) {
        const NSUInteger n = p.pointCount;
        if (n < 3) return;
        std::vector<CLLocationCoordinate2D> cs(n);
        [p getCoordinates:cs.data() range:NSMakeRange(0, n)];
        std::vector<Pt> r;
        r.reserve(n);
        for (const auto &c : cs) r.push_back({mercX(c.longitude), mercY(c.latitude)});
        out->push_back(std::move(r));
      };
      for (id f in features) {
        if (poly && [f isKindOfClass:poly]) addRing(f);
        else if (multi && [f isKindOfClass:multi])
          for (id p in [(id<INKMLNShape>)f polygons]) addRing(p);
      }
    };
    id<INKMLNVectorSource> src = base;
    collect([src featuresInSourceLayersWithIdentifiers:[NSSet setWithObject:@"water"] predicate:nil], water.get());
    collect([src featuresInSourceLayersWithIdentifiers:[NSSet setWithObjects:@"landcover", @"landuse", nil]
                                             predicate:[NSPredicate predicateWithFormat:@"kind == 'glacier'"]],
            ice.get());
  }
  NSArray<NSNumber *> *theme = _labelTheme ?: @[];
  NSString *fieldsKey = [_nameFields componentsJoinedByString:@","];
  __weak INKTerrainController *weakSelf = self;
  dispatch_async(_sceneQueue, ^{
    INKTerrainController *s = weakSelf;
    if (!s || s->_detached.load()) return;
    [s publishMasksWater:*water ice:*ice];
    [s publishLabels:*cands theme:theme key:fieldsKey];
  });
}

- (void)publishMasksWater:(std::vector<std::vector<Pt>> &)water ice:(std::vector<std::vector<Pt>> &)ice {
  uint64_t hash = 1469598103934665603ull;
  auto trim = [&hash](std::vector<std::vector<Pt>> &rings) {
    std::sort(rings.begin(), rings.end(), [](const auto &a, const auto &b) { return a.size() > b.size(); });
    size_t budget = kMaxMaskPoints;
    std::vector<std::vector<Pt>> kept;
    for (auto &r : rings) {
      if (r.size() > budget) continue;
      budget -= r.size();
      for (const auto &p : r) {
        const double v = p[0] + p[1] * 7.0;
        uint64_t bits;
        memcpy(&bits, &v, sizeof bits);
        hash = (hash ^ bits) * 1099511628211ull;
      }
      kept.push_back(std::move(r));
    }
    rings = std::move(kept);
  };
  trim(water);
  trim(ice);
  if (hash == _lastMaskHash) return;
  _lastMaskHash = hash;
  _engine->setMasks(std::move(water), std::move(ice));
}

static UIColor *themeColor(NSArray<NSNumber *> *t, int at, CGFloat alpha, UIColor *fallback) {
  if ((int)t.count < at + 3) return fallback;
  return [UIColor colorWithRed:t[at].doubleValue green:t[at + 1].doubleValue blue:t[at + 2].doubleValue alpha:alpha];
}

- (void)publishLabels:(const std::vector<Candidate> &)all theme:(NSArray<NSNumber *> *)theme key:(NSString *)fieldsKey {
  std::unordered_map<std::string, size_t> best;
  for (size_t i = 0; i < all.size(); i++) {
    auto it = best.find(all[i].key);
    if (it == best.end() || all[i].priority < all[it->second].priority) best[all[i].key] = i;
  }
  std::vector<const Candidate *> chosen;
  for (auto &kv : best) chosen.push_back(&all[kv.second]);
  std::sort(chosen.begin(), chosen.end(), [](auto a, auto b) {
    return a->priority != b->priority ? a->priority < b->priority : a->key < b->key;
  });
  if ((int)chosen.size() > kMaxLabels) chosen.resize(kMaxLabels);

  std::string tk = std::string([[theme componentsJoinedByString:@","] UTF8String]) + "|" + fieldsKey.UTF8String;
  if (tk != _themeKey) {
    _themeKey = tk;
    _shelf.reset();
    _lastLabelHash = 0;
  }
  uint64_t hash = 1469598103934665603ull;
  for (auto c : chosen) hash = (hash ^ std::hash<std::string>()(c->key)) * 1099511628211ull;
  if (hash == _lastLabelHash && !_shelf.rects.empty()) return;
  _lastLabelHash = hash;

  const CGFloat scale = std::min<CGFloat>(UIScreen.mainScreen.scale, 2.0);
  std::vector<Shelf::R> rects(chosen.size());
  std::vector<bool> ok(chosen.size(), false);
  for (int attempt = 0; attempt < 2; attempt++) {
    bool full = false;
    for (size_t i = 0; i < chosen.size(); i++) {
      auto it = _shelf.rects.find(chosen[i]->key);
      if (it != _shelf.rects.end()) {
        rects[i] = it->second;
        ok[i] = true;
        continue;
      }
      ok[i] = [self renderSprite:*chosen[i] theme:theme scale:scale into:rects[i]];
      if (!ok[i]) full = true;
    }
    if (!full) break;
    _shelf.reset();  // atlas full: start over with only what is wanted now
  }
  std::vector<LabelData> out;
  for (size_t i = 0; i < chosen.size(); i++) {
    if (!ok[i]) continue;
    const Candidate &c = *chosen[i];
    const Shelf::R &r = rects[i];
    LabelData d;
    d.id = (int)(std::hash<std::string>()(c.key) & 0x7fffffff);
    d.mercX = mercX(c.lng);
    d.mercY = mercY(c.lat);
    d.kind = c.kind;
    d.priority = c.priority;
    d.w = (float)(r.w / scale);
    d.h = (float)(r.h / scale);
    d.u0 = (float)r.x / kAtlasSize;
    d.v0 = (float)r.y / kAtlasSize;
    d.u1 = (float)(r.x + r.w) / kAtlasSize;
    d.v1 = (float)(r.y + r.h) / kAtlasSize;
    out.push_back(d);
  }
  _engine->setLabels(std::move(out));
}

/** Rasterise a plate: the name (and a summit's height) on a rounded paper card. */
- (BOOL)renderSprite:(const Candidate &)c theme:(NSArray<NSNumber *> *)theme scale:(CGFloat)s into:(Shelf::R &)rect {
  UIColor *ink = themeColor(theme, 4, 1, [UIColor colorWithRed:0.17 green:0.15 blue:0.12 alpha:1]);
  UIColor *muted = themeColor(theme, 7, 1, [UIColor colorWithRed:0.42 green:0.39 blue:0.34 alpha:1]);
  UIColor *waterInk = themeColor(theme, 10, 1, [UIColor colorWithRed:0.25 green:0.45 blue:0.6 alpha:1]);
  const CGFloat plateA = theme.count >= 4 ? theme[3].doubleValue : 0.94;
  UIColor *plate = themeColor(theme, 0, plateA, [UIColor colorWithRed:0.97 green:0.95 blue:0.91 alpha:0.94]);
  const CGFloat titleSize = c.kind == 1 ? (c.major ? 14.5 : 13) : c.kind == 0 ? 12.5 : 11.5;
  UIFont *titleFont = [(c.kind >= 2 ? _regular : _bold) fontWithSize:titleSize * s];
  NSMutableDictionary *ta = [@{NSFontAttributeName : titleFont,
                               NSForegroundColorAttributeName : c.kind == 3 ? waterInk : c.kind == 2 ? muted : ink} mutableCopy];
  if (c.kind == 3) ta[NSObliquenessAttributeName] = @0.18;
  NSString *title = c.title;
  CGSize ts = [title sizeWithAttributes:ta];
  const CGFloat maxW = 150 * s;
  while (ts.width > maxW && title.length > 3) {
    title = [[title substringToIndex:title.length - 2] stringByAppendingString:@"…"];
    ts = [title sizeWithAttributes:ta];
  }
  NSDictionary *sa = @{NSFontAttributeName : [_regular fontWithSize:10.5 * s], NSForegroundColorAttributeName : muted};
  const CGSize ss = c.sub ? [c.sub sizeWithAttributes:sa] : CGSizeZero;
  const CGFloat padX = 7 * s, padY = 4 * s, gap = 1 * s;
  const int w = (int)std::ceil(std::max(ts.width, ss.width) + padX * 2) + 2;
  const int h = (int)std::ceil(ts.height + (c.sub ? ss.height + gap : 0) + padY * 2) + 2;
  if (!_shelf.allocate(c.key, w, h, rect)) return NO;
  SpriteUpload up{rect.x, rect.y, w, h, std::vector<uint8_t>((size_t)w * h * 4, 0)};
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(up.rgba.data(), w, h, 8, w * 4, cs,
                                           kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(cs);
  if (!ctx) return NO;
  CGContextTranslateCTM(ctx, 0, h);
  CGContextScaleCTM(ctx, 1, -1);
  UIGraphicsPushContext(ctx);
  UIBezierPath *path = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(1, 1, w - 2, h - 2) cornerRadius:5 * s];
  [plate setFill];
  [path fill];
  [[ink colorWithAlphaComponent:0.22] setStroke];
  path.lineWidth = std::max<CGFloat>(1, 0.75 * s);
  [path stroke];
  [title drawAtPoint:CGPointMake((w - ts.width) / 2, 1 + padY) withAttributes:ta];
  if (c.sub) [c.sub drawAtPoint:CGPointMake((w - ss.width) / 2, 1 + padY + ts.height + gap) withAttributes:sa];
  UIGraphicsPopContext();
  CGContextRelease(ctx);
  std::lock_guard<std::mutex> lock(_spriteMutex);
  _spriteUploads.push_back(std::move(up));
  return YES;
}

// ---- per frame -------------------------------------------------------------------------------------

- (void)drawFrame:(const INKDrawingContext &)ctx layer:(id)layer {
  const int64_t t0 = nowNs();
  if (_recording.load()) {
    std::lock_guard<std::mutex> lock(_timesMutex);
    _frameTimes.push_back(t0);
  }
  const double pitchDeg = ctx.pitch * 180.0 / M_PI;
  _lastPitchDeg = pitchDeg;
  if (!_enabled.load() || _detached.load()) return;
  FrameInput in;
  for (int i = 0; i < 16; i++) in.P[i] = ctx.projectionMatrix.m[i];
  in.width = ctx.size.width;
  in.height = ctx.size.height;
  in.fovRad = ctx.fieldOfView > 0 ? ctx.fieldOfView : 0.6435011087932844;
  in.zoom = ctx.zoomLevel;
  in.lat = ctx.centerCoordinate.latitude;
  in.lng = ctx.centerCoordinate.longitude;
  in.bearingDeg = ctx.direction;
  in.pitchDeg = pitchDeg;
  in.timeMs = t0 / 1e6;
  FrameOutput out = _engine->frame(in);
  _drawnTiles = out.active ? (int)out.tiles.size() : 0;
  if (!out.active) return;
  id<MTLRenderCommandEncoder> enc = [(id<INKMLNCustomLayer>)layer renderEncoder];
  MTLRenderPassDescriptor *rp = [(id<INKMLNCustomLayer>)layer renderPassDesc];
  if (!enc || !rp || ![self ensurePipelinesFor:rp]) return;
  [self encode:out into:enc pass:rp];
  const int64_t cost = nowNs() - t0;
  _lastDrawMs = cost / 1e6;
  if (_recording.load()) {
    std::lock_guard<std::mutex> lock(_timesMutex);
    _costs.push_back(cost);
  }
  if (out.needsRepaint) {
    __weak INKTerrainController *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf requestRepaint];
    });
  }
}

- (GpuTile &)gpuTile:(const DrawTile &)d {
  GpuTile &g = _tiles[d.key];
  if (!g.buffer || g.version != d.version) {
    g.buffer = [_device newBufferWithBytes:d.attributes->data() length:d.attributes->size() * sizeof(float) options:MTLResourceStorageModeShared];
    if (d.detail) {
      if (!g.detail) {
        MTLTextureDescriptor *td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:kDetailSize height:kDetailSize mipmapped:NO];
        g.detail = [_device newTextureWithDescriptor:td];
      }
      [g.detail replaceRegion:MTLRegionMake2D(0, 0, kDetailSize, kDetailSize) mipmapLevel:0 withBytes:d.detail->data() bytesPerRow:kDetailSize * 4];
    }
    g.version = d.version;
  }
  g.lastFrame = _frameNo;
  return g;
}

- (void)quadX0:(float)x0 y0:(float)y0 x1:(float)x1 y1:(float)y1 u0:(float)u0 v0:(float)v0 u1:(float)u1 v1:(float)v1 color:(const float *)c mode:(float)mode {
  const float v[6][4] = {{x0, y0, u0, v0}, {x1, y0, u1, v0}, {x1, y1, u1, v1}, {x0, y0, u0, v0}, {x1, y1, u1, v1}, {x0, y1, u0, v1}};
  for (const auto &p : v) _spriteVerts.insert(_spriteVerts.end(), {p[0], p[1], p[2], p[3], c[0], c[1], c[2], c[3], mode});
}

- (void)encode:(const FrameOutput &)out into:(id<MTLRenderCommandEncoder>)enc pass:(MTLRenderPassDescriptor *)rp {
  _frameNo++;
  id<MTLTexture> target = rp.colorAttachments[0].texture;
  const double tw = target.width, th = target.height;
  const float density = out.width > 0 ? (float)(tw / out.width) : 1.0f;
  const float ramp = out.ramp;
  const int dbg = out.look.debugFlags;
  const bool imageryMode = out.look.imagery > 0.5f;
  [enc pushDebugGroup:@"inukshuk-terrain"];
  [enc setViewport:(MTLViewport){0, 0, tw, th, 0, 1}];
  [enc setScissorRect:(MTLScissorRect){0, 0, (NSUInteger)tw, (NSUInteger)th}];
  [enc setCullMode:MTLCullModeNone];

  // Pending uploads: label sprites and satellite imagery.
  float ink[3];
  {
    std::lock_guard<std::mutex> lock(_spriteMutex);
    for (auto &u : _spriteUploads)
      [_atlas replaceRegion:MTLRegionMake2D(u.x, u.y, u.w, u.h) mipmapLevel:0 withBytes:u.rgba.data() bytesPerRow:u.w * 4];
    _spriteUploads.clear();
    std::copy(_labelInk, _labelInk + 3, ink);
  }
  if (imageryMode && !_imagery) {
    MTLTextureDescriptor *id_ = [MTLTextureDescriptor new];
    id_.textureType = MTLTextureType2DArray;
    id_.pixelFormat = MTLPixelFormatRGBA8Unorm;
    id_.width = kImagerySize;
    id_.height = kImagerySize;
    id_.arrayLength = Engine::kImagerySlots;
    id_.usage = MTLTextureUsageShaderRead;
    _imagery = [_device newTextureWithDescriptor:id_];
  }
  if (_imagery)
    for (const auto &u : out.imageryUploads)
      [_imagery replaceRegion:MTLRegionMake2D(0, 0, kImagerySize, kImagerySize) mipmapLevel:0 slice:u.slot
                    withBytes:u.pixels->data() bytesPerRow:kImagerySize * 4 bytesPerImage:kImagerySize * kImagerySize * 4];

  // 1. Sky and haze, crossfading in with the ramp.
  if (!(dbg & 4) && out.skyVisible) {
    SkyU sky{};
    for (int i = 0; i < 3; i++) sky.rays[i] = simd_make_float4(out.skyRays[i][0], out.skyRays[i][1], out.skyRays[i][2], out.skyRays[i][3]);
    sky.horizon = f4(out.look.skyHorizon, 1);
    sky.zenith = f4(out.look.skyZenith, 1);
    sky.fog = f4(out.look.fogColor, 1);
    sky.misc = simd_make_float4(ramp, 0, 0, 0);
    [enc setRenderPipelineState:_skyPipeline];
    [enc setDepthStencilState:_depthOff];
    [enc setVertexBytes:&sky length:sizeof(sky) atIndex:0];
    [enc setFragmentBytes:&sky length:sizeof(sky) atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
  }

  // 2. Our depth: MapLibre's means nothing here.
  [enc setRenderPipelineState:_clearPipeline];
  [enc setDepthStencilState:_depthAlways];
  [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];

  // 3. Terrain.
  FrameU fu{};
  fu.light = simd_make_float4(out.light[0], out.light[1], out.light[2], out.exaggeration);
  fu.fogColor = f4(out.look.fogColor, out.ctc);
  fu.fogParams = simd_make_float4(out.look.fogStartCtc, out.look.fogDensity, out.look.fogEndCtc, ramp);
  fu.land = f4(out.look.land, out.look.contourOpacity);
  fu.rock = f4(out.look.rock, imageryMode ? 1 : 0);
  fu.water = f4(out.look.water, out.look.formStrength * 2.0f);
  fu.glacier = f4(out.look.glacier, density);
  fu.shadow = f4(out.look.shadow, (float)out.contourBase);
  fu.highlight = f4(out.look.highlight, 0);
  fu.contour = f4(out.look.contour, 0);
  fu.contourMajor = f4(out.look.contourMajor, 0);
  [enc setRenderPipelineState:_terrainPipeline];
  [enc setDepthStencilState:_depthLess];
  [enc setVertexBuffer:_gridBuffer offset:0 atIndex:0];
  [enc setFragmentBytes:&fu length:sizeof(fu) atIndex:0];
  [enc setFragmentSamplerState:_sampler atIndex:0];
  [enc setFragmentTexture:(_imagery ?: _flatImagery) atIndex:1];
  if (!(dbg & 2)) {
    for (const auto &d : out.tiles) {
      TileU tu{};
      tu.matrix = mat(d.matrix);
      const bool flat = !d.attributes;
      tu.a = simd_make_float4(d.morph, d.fromFlat, out.hRef, out.exaggeration * ramp);
      tu.b = simd_make_float4(d.skirtDepth * ramp, out.farW, flat ? 1 : 0, 0);
      tu.ia = simd_make_float4((float)d.imgA, d.winA[0], d.winA[1], d.winA[2]);
      tu.ib = simd_make_float4((float)d.imgB, d.winB[0], d.winB[1], d.winB[2]);
      tu.ix = simd_make_float4(d.imgBlend, 0, 0, 0);
      if (!_imagery) tu.ia.x = tu.ib.x = -1;
      id<MTLTexture> detail = _flatDetail;
      if (flat) {
        [enc setVertexBuffer:_zeroBuffer offset:0 atIndex:1];
      } else {
        GpuTile &g = [self gpuTile:d];
        [enc setVertexBuffer:g.buffer offset:0 atIndex:1];
        if (g.detail) detail = g.detail;
      }
      [enc setVertexBytes:&tu length:sizeof(tu) atIndex:2];
      [enc setFragmentBytes:&tu length:sizeof(tu) atIndex:2];
      [enc setFragmentTexture:detail atIndex:0];
      [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:_indexCount indexType:MTLIndexTypeUInt16 indexBuffer:_indexBuffer indexBufferOffset:0];
    }
  }

  // 4. Trails on the surface: halo, then line.
  if (!out.lines.empty()) {
    [enc setRenderPipelineState:_linePipeline];
    [enc setDepthStencilState:_depthTest];
    for (const auto &l : out.lines) {
      GpuLine &g = _lines[l.id];
      if (!g.buffer || g.version != l.version) {
        g.buffer = l.vertices->empty() ? nil : [_device newBufferWithBytes:l.vertices->data() length:l.vertices->size() * sizeof(float) options:MTLResourceStorageModeShared];
        g.version = l.version;
        g.count = l.vertices->size() / 8;
      }
      g.lastFrame = _frameNo;
      if (!g.buffer || g.count == 0) continue;
      [enc setVertexBuffer:g.buffer offset:0 atIndex:0];
      LineU lu{};
      lu.m = mat(l.matrix);
      lu.view = simd_make_float4(out.width, out.height, 0, 0);
      lu.p = simd_make_float4(out.hRef, out.exaggeration * ramp, out.farW, l.style.haloWidth);
      lu.color = simd_make_float4(l.style.halo[0], l.style.halo[1], l.style.halo[2], l.style.halo[3] * ramp);
      [enc setVertexBytes:&lu length:sizeof(lu) atIndex:1];
      [enc setFragmentBytes:&lu length:sizeof(lu) atIndex:1];
      [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:g.count];
      lu.p.w = l.style.width;
      lu.color = simd_make_float4(l.style.color[0], l.style.color[1], l.style.color[2], l.style.color[3] * ramp);
      [enc setVertexBytes:&lu length:sizeof(lu) atIndex:1];
      [enc setFragmentBytes:&lu length:sizeof(lu) atIndex:1];
      [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:g.count];
    }
  }

  // 5. Pins and the location marker (screen space; the engine hid what the terrain occludes).
  _spriteVerts.clear();
  for (const auto &l : out.labels) {
    const float a = l.opacity * ramp;
    const float stem[4] = {ink[0], ink[1], ink[2], 0.75f * a};
    [self quadX0:l.gx - 0.75f y0:l.y1 x1:l.gx + 0.75f y1:l.gy u0:0 v0:0 u1:0 v1:0 color:stem mode:1];
    const float dot[4] = {ink[0], ink[1], ink[2], 0.9f * a};
    const float r = 3.0f * l.scale;
    [self quadX0:l.gx - r y0:l.gy - r x1:l.gx + r y1:l.gy + r u0:0 v0:0 u1:1 v1:1 color:dot mode:2];
    const float plate[4] = {1, 1, 1, a};
    [self quadX0:l.x0 y0:l.y0 x1:l.x1 y1:l.y1 u0:l.u0 v0:l.v0 u1:l.u1 v1:l.v1 color:plate mode:0];
  }
  if (out.puck.visible) {
    const float halo[4] = {0.16f, 0.45f, 0.95f, 0.18f * ramp};
    const float blue[4] = {0.16f, 0.45f, 0.95f, ramp};
    const float gx = out.puck.gx, gy = out.puck.gy;
    [self quadX0:gx - 22 y0:gy - 22 x1:gx + 22 y1:gy + 22 u0:0 v0:0 u1:1 v1:1 color:halo mode:2];
    [self quadX0:gx - 9 y0:gy - 9 x1:gx + 9 y1:gy + 9 u0:0 v0:0 u1:1 v1:1 color:blue mode:3];
  }
  if (!_spriteVerts.empty()) {
    const NSUInteger bytes = _spriteVerts.size() * sizeof(float);
    _spriteIndex = (_spriteIndex + 1) % 3;
    __strong id<MTLBuffer> &buf = _spriteBuffers[_spriteIndex];
    if (!buf || buf.length < bytes) buf = [_device newBufferWithLength:std::max<NSUInteger>(bytes * 2, 64 * 1024) options:MTLResourceStorageModeShared];
    memcpy(buf.contents, _spriteVerts.data(), bytes);
    const simd_float4 view = simd_make_float4(out.width, out.height, 0, 0);
    [enc setRenderPipelineState:_spritePipeline];
    [enc setDepthStencilState:_depthOff];
    [enc setVertexBuffer:buf offset:0 atIndex:0];
    [enc setVertexBytes:&view length:sizeof(view) atIndex:1];
    [enc setFragmentTexture:_atlas atIndex:0];
    [enc setFragmentSamplerState:_sampler atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:_spriteVerts.size() / 9];
  }
  [enc popDebugGroup];

  if (_tiles.size() > 420) {
    for (auto it = _tiles.begin(); it != _tiles.end();) {
      if (_frameNo - it->second.lastFrame > 120) it = _tiles.erase(it);
      else ++it;
    }
  }
  for (auto it = _lines.begin(); it != _lines.end();) {
    if (_frameNo - it->second.lastFrame > 60) it = _lines.erase(it);
    else ++it;
  }
}

// ---- stats / recording ---------------------------------------------------------------------------------

- (NSArray<NSNumber *> *)stats {
  const EngineStats s = _engine->stats();
  return @[ @(s.demCount), @(s.demBytes), @(s.meshCount), @(_drawnTiles), @(s.flatTiles), @(s.inFlight),
            @(s.requested), @(s.failed), @(s.lastFrameCpuMs), @(_lastDrawMs), @(_lastPitchDeg), @(_tiles.size()),
            @(s.labelsShown), @(s.imagerySlots), @(s.bakeQueue) ];
}

- (void)trimMemory {
  _engine->trimMemory();
}

- (void)setPitch:(double)deg {
  id<INKMLNMapView> map = (id<INKMLNMapView>)_mapView;
  if (!map) return;
  id<INKMLNCamera> cam = [map.camera copyWithZone:nil];
  cam.pitch = fmax(0, fmin(deg, _enabled.load() ? _maxPitch : 60.0));
  [map setCamera:cam animated:NO];
}

- (void)setRecording:(BOOL)on {
  std::lock_guard<std::mutex> lock(_timesMutex);
  if (on) {
    _frameTimes.clear();
    _costs.clear();
  }
  _recording = on;
}

- (NSArray<NSNumber *> *)takeFrameTimes:(BOOL)costs {
  std::lock_guard<std::mutex> lock(_timesMutex);
  const auto &v = costs ? _costs : _frameTimes;
  NSMutableArray *a = [NSMutableArray arrayWithCapacity:v.size()];
  for (auto t : v) [a addObject:@((double)t)];
  return a;
}

// ---- bench: a camera script (iOS can't synthesise multi-touch) --------------------------------------------

- (void)runBenchWithSteps:(NSArray<NSDictionary *> *)steps completion:(void (^)(void))done {
  if (steps.count == 0) {
    steps = @[
      @{@"kind" : @"idle", @"durationMs" : @600, @"amount" : @0},
      @{@"kind" : @"pitch", @"durationMs" : @3000, @"amount" : @80},
      @{@"kind" : @"idle", @"durationMs" : @300, @"amount" : @0},
      @{@"kind" : @"rotate", @"durationMs" : @3500, @"amount" : @300},
      @{@"kind" : @"idle", @"durationMs" : @300, @"amount" : @0},
      @{@"kind" : @"pan", @"durationMs" : @4000, @"amount" : @0.02},
      @{@"kind" : @"idle", @"durationMs" : @300, @"amount" : @0},
      @{@"kind" : @"fling", @"durationMs" : @1000, @"amount" : @0.02},
      @{@"kind" : @"fling", @"durationMs" : @1000, @"amount" : @-0.02},
      @{@"kind" : @"fling", @"durationMs" : @1200, @"amount" : @0.02},
    ];
  }
  _benchSteps = [steps mutableCopy];
  _benchStep = nil;
  _benchDone = [done copy];
  [_benchLink invalidate];
  _benchLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(benchTick:)];
  if (@available(iOS 15.0, *)) _benchLink.preferredFrameRateRange = CAFrameRateRangeMake(60, 60, 60);
  [_benchLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
}

- (void)benchTick:(CADisplayLink *)link {
  id<INKMLNMapView> map = (id<INKMLNMapView>)_mapView;
  if (!map || _detached.load()) {
    [link invalidate];
    return;
  }
  const CFTimeInterval now = CACurrentMediaTime();
  if (!_benchStep) {
    if (_benchSteps.count == 0) {
      [link invalidate];
      _benchLink = nil;
      if (_benchDone) _benchDone();
      _benchDone = nil;
      return;
    }
    _benchStep = _benchSteps.firstObject;
    [_benchSteps removeObjectAtIndex:0];
    _benchStepStart = now;
    _benchBase = [map.camera copyWithZone:nil];
  }
  NSString *kind = _benchStep[@"kind"];
  const double dur = [_benchStep[@"durationMs"] doubleValue] / 1000.0;
  const double amount = [_benchStep[@"amount"] doubleValue];
  const double t = dur > 0 ? fmin(1.0, (now - _benchStepStart) / dur) : 1.0;
  id<INKMLNCamera> cam = [_benchBase copyWithZone:nil];
  if ([kind isEqualToString:@"pitch"]) {
    const double p = t < 0.6 ? t / 0.6 : 1.0 - (t - 0.6) / 0.8;
    cam.pitch = fmin(_benchBase.pitch + (amount - _benchBase.pitch) * p, _enabled.load() ? _maxPitch : 60.0);
    [map setCamera:cam animated:NO];
  } else if ([kind isEqualToString:@"rotate"]) {
    cam.heading = fmod(_benchBase.heading + amount * t, 360.0);
    [map setCamera:cam animated:NO];
  } else if ([kind isEqualToString:@"pan"]) {
    const double a = 2 * M_PI * t;
    CLLocationCoordinate2D c = _benchBase.centerCoordinate;
    c.longitude += amount * sin(a);
    c.latitude += amount * 0.6 * sin(2 * a);
    cam.centerCoordinate = c;
    [map setCamera:cam animated:NO];
  } else if ([kind isEqualToString:@"fling"]) {
    const double travel = amount * (1.0 - exp(-5.0 * t)) / (1.0 - exp(-5.0));
    CLLocationCoordinate2D c = _benchBase.centerCoordinate;
    c.latitude += travel;
    cam.centerCoordinate = c;
    [map setCamera:cam animated:NO];
  }
  if (t >= 1.0) _benchStep = nil;
}

@end
