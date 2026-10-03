// iOS native 3D terrain: MLNCustomStyleLayer (Metal) + a post-pass on
// MapLibre's own command buffer. See docs/plans/native-terrain.md.
//
// Why a post-pass: on Metal a texture can't be sampled while it is the
// attachment of the live render encoder, and MapLibre owns that encoder. So
// our layer's drawInMapView only RECORDS the frame (camera, command buffer);
// the drawing happens right after MapLibre ends its pass and before it
// presents: MapLibre's MTKView is re-classed to INKTerrainMTKView (a
// zero-ivar subclass), whose currentDrawable — called by MapLibre's swap()
// right before presentDrawable:/commit — first encodes a blit of the frame
// into our capture texture and our terrain pass on top.
#import "INKTerrainController.h"

#import <CoreLocation/CoreLocation.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>

#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <unordered_map>
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
- (void)addLayer:(id)layer;
- (void)removeLayer:(id)layer;
@end

@protocol INKMLNMapView <NSObject>
@property(nonatomic) CGFloat maximumPitch;
@property(nonatomic, copy) id<INKMLNCamera> camera;
@property(nonatomic, readonly, nullable) id<INKMLNStyle> style;
- (void)setCamera:(id<INKMLNCamera>)camera animated:(BOOL)animated;
@end

@protocol INKMLNCustomLayer <NSObject>
- (instancetype)initWithIdentifier:(NSString *)identifier;
- (void)setNeedsDisplay;
@property(nonatomic, weak) id<MTLCommandBuffer> commandBuffer;
@end

static NSString *const kLayerId = @"inukshuk-terrain-3d";
static char kControllerKey;

@interface INKTerrainController ()
- (void)drawFrame:(const INKDrawingContext &)ctx layer:(id)layer;
- (void)encodePostPassWithDrawable:(id<CAMetalDrawable>)drawable;
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

// The re-classed MapLibre MTKView. No ivars (object_setClass-safe).
@interface INKTerrainMTKView : MTKView
@end

@implementation INKTerrainMTKView
- (id<CAMetalDrawable>)currentDrawable {
  id<CAMetalDrawable> d = [super currentDrawable];
  INKTerrainController *c = objc_getAssociatedObject(self, &kControllerKey);
  if (c && d) [c encodePostPassWithDrawable:d];
  return d;
}
@end

// ---- Metal shaders -----------------------------------------------------------------

static NSString *const kShaderSource = @R"MSL(
#include <metal_stdlib>
using namespace metal;

struct TileU {
  float4x4 matrix;
  float4 a;  // morph, fromFlat, hRef, scale (exaggeration * ramp)
  float4 b;  // skirt (depth * ramp), far, -, -
};
struct FrameU {
  float4 light;     // xyz light, w form (strength * 2 * ramp)
  float4 fogColor;  // rgb, w exaggeration
  float4 fogParams; // start, density, end (ctc), w ctc
  float4 misc;      // ramp, -, -, -
};
struct VIn {
  float3 grid [[attribute(0)]];
  float4 attr [[attribute(1)]];
};
struct VOut {
  float4 position [[position]];
  float3 flatPos;
  float2 slope;
  float dist;
};

vertex VOut terrain_vs(VIn in [[stage_in]], constant TileU &u [[buffer(2)]]) {
  float to = in.attr.y - u.a.z;
  float from = u.a.y > 0.5 ? 0.0 : in.attr.x - u.a.z;
  float dh = mix(to, from, u.a.x);
  float z = dh * u.a.w - in.grid.z * u.b.x;
  float4 flatPos = u.matrix * float4(in.grid.xy, 0.0, 1.0);
  float4 pos = u.matrix * float4(in.grid.xy, z, 1.0);
  VOut o;
  o.flatPos = flatPos.xyw;
  o.slope = in.attr.zw;
  o.dist = pos.w;
  pos.z = pos.w * pos.w / u.b.y;  // our own linear depth, z_ndc = w / far
  o.position = pos;
  return o;
}

fragment float4 terrain_fs(VOut in [[stage_in]], constant FrameU &f [[buffer(0)]],
                           texture2d<float> drape [[texture(0)]], sampler s [[sampler(0)]]) {
  float2 ndc = in.flatPos.xy / in.flatPos.z;
  float2 uv = float2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  float topOut = max(-uv.y, 0.0);
  float3 c = drape.sample(s, clamp(uv, float2(0.0), float2(1.0))).rgb;
  float3 n = normalize(float3(-in.slope * f.fogColor.w, 1.0));
  float lambert = max(dot(n, f.light.xyz), 0.0);
  c *= 1.0 + (lambert - f.light.z) * f.light.w;
  float d = in.dist / f.fogParams.w;
  float fog = d > f.fogParams.x ? 1.0 - exp(-f.fogParams.y * (d - f.fogParams.x)) : 0.0;
  float t = clamp((d - f.fogParams.z * 0.85) / (f.fogParams.z * 0.15), 0.0, 1.0);
  fog = max(fog, t * t * (3.0 - 2.0 * t));
  fog = max(fog, clamp(topOut * 12.0, 0.0, 1.0));
  return float4(mix(c, f.fogColor.rgb, clamp(fog, 0.0, 1.0) * f.misc.x), 1.0);
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
)MSL";

struct TileU {
  simd_float4x4 matrix;
  simd_float4 a;
  simd_float4 b;
};
struct FrameU {
  simd_float4 light, fogColor, fogParams, misc;
};
struct SkyU {
  simd_float4 rays[3];
  simd_float4 horizon, zenith, fog, misc;
};

// ---- the controller -------------------------------------------------------------------

@implementation INKTerrainController {
  __weak UIView *_mapView;
  MTKView *_mtkView;
  Class _originalMtkClass;
  id _layer;
  std::unique_ptr<Engine> _engine;
  std::atomic<bool> _enabled;
  std::atomic<bool> _detached;
  double _maxPitch;
  BOOL _networkAllowed;
  NSURLSession *_session;
  NSString *_cacheDir;
  NSTimer *_watcher;
  id _memoryObserver;
  // Metal
  id<MTLDevice> _device;
  id<MTLRenderPipelineState> _terrainPipeline, _skyPipeline;
  id<MTLDepthStencilState> _depthLess, _depthOff;
  id<MTLSamplerState> _sampler;
  id<MTLBuffer> _gridBuffer, _indexBuffer, _zeroBuffer;
  NSUInteger _indexCount;
  id<MTLTexture> _capture, _depth;
  struct GpuTile {
    id<MTLBuffer> buffer;
    uint32_t version = 0;
    uint64_t lastFrame = 0;
  };
  std::unordered_map<uint64_t, GpuTile> _tiles;
  uint64_t _frameNo;
  // pending post-pass
  BOOL _pending;
  id<MTLCommandBuffer> _pendingCommandBuffer;
  FrameOutput _pendingOut;
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
  CLLocationCoordinate2D _benchVelocity;
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
  _networkAllowed = YES;
  for (UIView *sub in mapView.subviews) {
    if ([sub isKindOfClass:[MTKView class]]) {
      _mtkView = (MTKView *)sub;
      break;
    }
  }
  if (!_mtkView || object_getClass(_mtkView) != [MTKView class]) return nil;
  _device = _mtkView.device;
  if (!_device || ![self buildPipelines]) return nil;

  NSString *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  _cacheDir = [caches stringByAppendingPathComponent:@"dem"];
  [[NSFileManager defaultManager] createDirectoryAtPath:_cacheDir withIntermediateDirectories:YES attributes:nil error:nil];
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
      [weakSelf] {
        dispatch_async(dispatch_get_main_queue(), ^{
          [weakSelf requestRepaint];
        });
      });
  return self;
}

- (BOOL)buildPipelines {
  NSError *err = nil;
  id<MTLLibrary> lib = [_device newLibraryWithSource:kShaderSource options:nil error:&err];
  if (!lib) {
    NSLog(@"[InukshukTerrain] shader compile failed: %@", err);
    return NO;
  }
  MTLVertexDescriptor *vd = [MTLVertexDescriptor vertexDescriptor];
  vd.attributes[0].format = MTLVertexFormatFloat3;
  vd.attributes[0].bufferIndex = 0;
  vd.attributes[0].offset = 0;
  vd.attributes[1].format = MTLVertexFormatFloat4;
  vd.attributes[1].bufferIndex = 1;
  vd.attributes[1].offset = 0;
  vd.layouts[0].stride = 3 * sizeof(float);
  vd.layouts[1].stride = 4 * sizeof(float);

  MTLRenderPipelineDescriptor *pd = [MTLRenderPipelineDescriptor new];
  pd.vertexFunction = [lib newFunctionWithName:@"terrain_vs"];
  pd.fragmentFunction = [lib newFunctionWithName:@"terrain_fs"];
  pd.vertexDescriptor = vd;
  pd.colorAttachments[0].pixelFormat = _mtkView.colorPixelFormat;
  pd.depthAttachmentPixelFormat = MTLPixelFormatDepth32Float;
  _terrainPipeline = [_device newRenderPipelineStateWithDescriptor:pd error:&err];
  if (!_terrainPipeline) {
    NSLog(@"[InukshukTerrain] terrain pipeline failed: %@", err);
    return NO;
  }
  MTLRenderPipelineDescriptor *sd = [MTLRenderPipelineDescriptor new];
  sd.vertexFunction = [lib newFunctionWithName:@"sky_vs"];
  sd.fragmentFunction = [lib newFunctionWithName:@"sky_fs"];
  sd.colorAttachments[0].pixelFormat = _mtkView.colorPixelFormat;
  sd.colorAttachments[0].blendingEnabled = YES;
  sd.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorSourceAlpha;
  sd.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
  sd.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorZero;
  sd.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOne;
  sd.depthAttachmentPixelFormat = MTLPixelFormatDepth32Float;
  _skyPipeline = [_device newRenderPipelineStateWithDescriptor:sd error:&err];
  if (!_skyPipeline) {
    NSLog(@"[InukshukTerrain] sky pipeline failed: %@", err);
    return NO;
  }
  MTLDepthStencilDescriptor *dl = [MTLDepthStencilDescriptor new];
  dl.depthCompareFunction = MTLCompareFunctionLess;
  dl.depthWriteEnabled = YES;
  _depthLess = [_device newDepthStencilStateWithDescriptor:dl];
  MTLDepthStencilDescriptor *doff = [MTLDepthStencilDescriptor new];
  doff.depthCompareFunction = MTLCompareFunctionAlways;
  doff.depthWriteEnabled = NO;
  _depthOff = [_device newDepthStencilStateWithDescriptor:doff];
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
  return YES;
}

// ---- lifecycle ----------------------------------------------------------------------------

static LookParams lookFrom(NSArray<NSNumber *> *a) {
  LookParams l;
  if (a.count < 14) return l;
  l.exaggeration = a[0].floatValue;
  for (int i = 0; i < 3; i++) {
    l.fogColor[i] = a[1 + i].floatValue;
    l.skyHorizon[i] = a[4 + i].floatValue;
    l.skyZenith[i] = a[7 + i].floatValue;
  }
  l.formStrength = a[10].floatValue;
  l.fogStartCtc = a[11].floatValue;
  l.fogDensity = a[12].floatValue;
  l.fogEndCtc = a[13].floatValue;
  return l;
}

- (BOOL)attachWithLook:(NSArray<NSNumber *> *)look
               enabled:(BOOL)enabled
        networkAllowed:(BOOL)networkAllowed
              maxPitch:(double)maxPitch {
  _maxPitch = maxPitch;
  [self updateWithLook:look enabled:enabled networkAllowed:networkAllowed];
  objc_setAssociatedObject(_mtkView, &kControllerKey, self, OBJC_ASSOCIATION_ASSIGN);
  _originalMtkClass = object_getClass(_mtkView);
  object_setClass(_mtkView, [INKTerrainMTKView class]);
  _mtkView.framebufferOnly = NO;
  [self ensureLayer];
  __weak INKTerrainController *weakSelf = self;
  _watcher = [NSTimer scheduledTimerWithTimeInterval:0.4
                                             repeats:YES
                                               block:^(NSTimer *t) {
                                                 [weakSelf ensureLayer];
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
  if (map) map.maximumPitch = enabled ? _maxPitch : 60;
  [self requestRepaint];
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
  if (_mtkView) {
    objc_setAssociatedObject(_mtkView, &kControllerKey, nil, OBJC_ASSOCIATION_ASSIGN);
    if (object_getClass(_mtkView) == [INKTerrainMTKView class] && _originalMtkClass) {
      object_setClass(_mtkView, _originalMtkClass);
    }
    _mtkView.framebufferOnly = YES;
  }
  [_session invalidateAndCancel];
  _pending = NO;
  _pendingCommandBuffer = nil;
  _tiles.clear();
}

- (void)dealloc {
  [self detach];
}

- (void)ensureLayer {
  if (_detached.load()) return;
  id<INKMLNMapView> map = (id<INKMLNMapView>)_mapView;
  id<INKMLNStyle> style = map.style;
  if (!style) return;
  if (_layer && [style layerWithIdentifier:kLayerId] == _layer) return;
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

// ---- DEM fetching ------------------------------------------------------------------------------

- (void)fetchDemZ:(int)z x:(int)x y:(int)y {
  NSString *path = [_cacheDir stringByAppendingPathComponent:[NSString stringWithFormat:@"dem-%d-%d-%d.png", z, x, y]];
  __weak INKTerrainController *weakSelf = self;
  NSOperationQueue *q = _session.delegateQueue;
  BOOL net = _networkAllowed;
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

// ---- per frame -------------------------------------------------------------------------------------

- (void)drawFrame:(const INKDrawingContext &)ctx layer:(id)layer {
  const int64_t t0 = nowNs();
  if (_recording.load()) {
    std::lock_guard<std::mutex> lock(_timesMutex);
    _frameTimes.push_back(t0);
  }
  const double pitchDeg = ctx.pitch * 180.0 / M_PI;
  _lastPitchDeg = pitchDeg;
  _pending = NO;
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
  id<MTLCommandBuffer> cb = [(id<INKMLNCustomLayer>)layer commandBuffer];
  if (!cb) return;
  _pendingOut = std::move(out);
  _pendingCommandBuffer = cb;
  _pending = YES;
  if (_pendingOut.needsRepaint) {
    __weak INKTerrainController *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf requestRepaint];
    });
  }
}

- (void)ensureTargets:(id<MTLTexture>)target {
  const NSUInteger w = target.width, h = target.height;
  if (!_capture || _capture.width != w || _capture.height != h || _capture.pixelFormat != target.pixelFormat) {
    MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:target.pixelFormat width:w height:h mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    _capture = [_device newTextureWithDescriptor:d];
    MTLTextureDescriptor *dd = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatDepth32Float width:w height:h mipmapped:NO];
    dd.usage = MTLTextureUsageRenderTarget;
    dd.storageMode = MTLStorageModePrivate;
    _depth = [_device newTextureWithDescriptor:dd];
  }
}

- (id<MTLBuffer>)bufferForTile:(const DrawTile &)d {
  if (!d.attributes) return _zeroBuffer;
  GpuTile &g = _tiles[d.key];
  if (!g.buffer || g.version != d.version) {
    g.buffer = [_device newBufferWithBytes:d.attributes->data() length:d.attributes->size() * sizeof(float) options:MTLResourceStorageModeShared];
    g.version = d.version;
  }
  g.lastFrame = _frameNo;
  return g.buffer;
}

- (void)encodePostPassWithDrawable:(id<CAMetalDrawable>)drawable {
  if (!_pending || !_pendingCommandBuffer || _detached.load()) return;
  _pending = NO;
  id<MTLCommandBuffer> cb = _pendingCommandBuffer;
  _pendingCommandBuffer = nil;
  const int64_t t0 = nowNs();
  const FrameOutput &out = _pendingOut;
  id<MTLTexture> target = drawable.texture;
  if (!target || target.framebufferOnly) return;
  [self ensureTargets:target];
  _frameNo++;

  // 1. Capture the finished map frame.
  id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
  [blit copyFromTexture:target toTexture:_capture];
  [blit endEncoding];

  // 2. Sky + terrain on top of it.
  MTLRenderPassDescriptor *rp = [MTLRenderPassDescriptor renderPassDescriptor];
  rp.colorAttachments[0].texture = target;
  rp.colorAttachments[0].loadAction = MTLLoadActionLoad;
  rp.colorAttachments[0].storeAction = MTLStoreActionStore;
  rp.depthAttachment.texture = _depth;
  rp.depthAttachment.loadAction = MTLLoadActionClear;
  rp.depthAttachment.clearDepth = 1.0;
  rp.depthAttachment.storeAction = MTLStoreActionDontCare;
  id<MTLRenderCommandEncoder> enc = [cb renderCommandEncoderWithDescriptor:rp];
  enc.label = @"inukshuk-terrain";

  SkyU sky{};
  for (int i = 0; i < 3; i++) sky.rays[i] = simd_make_float4(out.skyRays[i][0], out.skyRays[i][1], out.skyRays[i][2], out.skyRays[i][3]);
  sky.horizon = simd_make_float4(out.look.skyHorizon[0], out.look.skyHorizon[1], out.look.skyHorizon[2], 1);
  sky.zenith = simd_make_float4(out.look.skyZenith[0], out.look.skyZenith[1], out.look.skyZenith[2], 1);
  sky.fog = simd_make_float4(out.look.fogColor[0], out.look.fogColor[1], out.look.fogColor[2], 1);
  sky.misc = simd_make_float4(out.ramp, 0, 0, 0);
  [enc setRenderPipelineState:_skyPipeline];
  [enc setDepthStencilState:_depthOff];
  [enc setVertexBytes:&sky length:sizeof(sky) atIndex:0];
  [enc setFragmentBytes:&sky length:sizeof(sky) atIndex:0];
  [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];

  FrameU fu{};
  fu.light = simd_make_float4(out.light[0], out.light[1], out.light[2], out.look.formStrength * 2.0f * out.ramp);
  fu.fogColor = simd_make_float4(out.look.fogColor[0], out.look.fogColor[1], out.look.fogColor[2], out.exaggeration);
  fu.fogParams = simd_make_float4(out.look.fogStartCtc, out.look.fogDensity, out.look.fogEndCtc, out.ctc);
  fu.misc = simd_make_float4(out.ramp, 0, 0, 0);
  [enc setRenderPipelineState:_terrainPipeline];
  [enc setDepthStencilState:_depthLess];
  [enc setCullMode:MTLCullModeNone];
  [enc setVertexBuffer:_gridBuffer offset:0 atIndex:0];
  [enc setFragmentBytes:&fu length:sizeof(fu) atIndex:0];
  [enc setFragmentTexture:_capture atIndex:0];
  [enc setFragmentSamplerState:_sampler atIndex:0];
  for (const auto &d : out.tiles) {
    TileU tu{};
    for (int c = 0; c < 4; c++) tu.matrix.columns[c] = simd_make_float4(d.matrix[c * 4], d.matrix[c * 4 + 1], d.matrix[c * 4 + 2], d.matrix[c * 4 + 3]);
    tu.a = simd_make_float4(d.morph, d.fromFlat, out.hRef, out.exaggeration * out.ramp);
    tu.b = simd_make_float4(d.skirtDepth * out.ramp, out.farW, 0, 0);
    [enc setVertexBuffer:[self bufferForTile:d] offset:0 atIndex:1];
    [enc setVertexBytes:&tu length:sizeof(tu) atIndex:2];
    [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:_indexCount indexType:MTLIndexTypeUInt16 indexBuffer:_indexBuffer indexBufferOffset:0];
  }
  [enc endEncoding];

  if (_tiles.size() > 420) {
    for (auto it = _tiles.begin(); it != _tiles.end();) {
      if (_frameNo - it->second.lastFrame > 120) it = _tiles.erase(it);
      else ++it;
    }
  }
  const int64_t cost = nowNs() - t0;
  _lastDrawMs = cost / 1e6;
  if (_recording.load()) {
    std::lock_guard<std::mutex> lock(_timesMutex);
    _costs.push_back(cost);
  }
}

// ---- stats / recording ---------------------------------------------------------------------------------

- (NSArray<NSNumber *> *)stats {
  const EngineStats s = _engine->stats();
  return @[ @(s.demCount), @(s.demBytes), @(s.meshCount), @(_drawnTiles), @(s.flatTiles), @(s.inFlight),
            @(s.requested), @(s.failed), @(s.lastFrameCpuMs), @(_lastDrawMs), @(_lastPitchDeg), @(_tiles.size()) ];
}

- (void)trimMemory {
  _engine->trimMemory();
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
    // up to `amount` degrees and back down halfway, like a two-finger drag
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
    // a fast flick then exponential deceleration, like MapLibre's fling
    const double travel = amount * (1.0 - exp(-5.0 * t)) / (1.0 - exp(-5.0));
    CLLocationCoordinate2D c = _benchBase.centerCoordinate;
    c.latitude += travel;
    cam.centerCoordinate = c;
    [map setCamera:cam animated:NO];
  }
  if (t >= 1.0) _benchStep = nil;
}

@end
