#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * iOS native 3D terrain for one MapLibre map view (docs/plans/native-terrain.md).
 * Pure Objective-C surface for the Swift Expo module; the implementation is
 * Objective-C++ (shared C++ engine + Metal). MapLibre is reached through the
 * Objective-C runtime only, so this pod needs no compile-time MapLibre link.
 */
@interface INKTerrainController : NSObject

/** The MLNMapView found inside `host` (depth-first), or nil. */
+ (nullable UIView *)findMapViewIn:(UIView *)host;

- (nullable instancetype)initWithMapView:(UIView *)mapView;

- (BOOL)attachWithLook:(NSArray<NSNumber *> *)look
               enabled:(BOOL)enabled
        networkAllowed:(BOOL)networkAllowed
              maxPitch:(double)maxPitch;
- (void)updateWithLook:(NSArray<NSNumber *> *)look
               enabled:(BOOL)enabled
        networkAllowed:(BOOL)networkAllowed;
/** Pin plates: plate rgba, ink rgb, muted rgb, water rgb; name properties in order. */
- (void)setLabelTheme:(NSArray<NSNumber *> *)theme
           nameFields:(NSArray<NSString *> *)nameFields
               labels:(BOOL)labels;
/** Replaces every line: dictionaries {id, coords: [lng, lat, …], style: [11 floats]}. */
- (void)setLines:(NSArray<NSDictionary *> *)lines;
- (void)setPuckVisible:(BOOL)visible lng:(double)lng lat:(double)lat;
/** The style JSON draped per terrain tile ('' = none: the shaded relief model). */
- (void)setDrapeStyle:(NSString *)json;
- (void)detach;

/** See namedTerrainStats (src/lib/nativeTerrain.ts) for the order. */
- (NSArray<NSNumber *> *)stats;
- (void)trimMemory;
/** Programmatic pitch (QA camera), clamped to the current ceiling. */
- (void)setPitch:(double)deg;
/** QA camera: centre, zoom, bearing and pitch in one synchronous move. */
- (void)jumpToLat:(double)lat lng:(double)lng zoom:(double)zoom pitch:(double)pitch bearing:(double)bearing;
- (void)setRecording:(BOOL)on;
/** Frame timestamps (ns) or per-frame layer costs (ns) recorded since setRecording:YES. */
- (NSArray<NSNumber *> *)takeFrameTimes:(BOOL)costs;
/** Camera-driven gesture script (iOS can't synthesise touches); calls `done` on main. */
- (void)runBenchWithSteps:(NSArray<NSDictionary *> *)steps completion:(void (^)(void))done;

@end

NS_ASSUME_NONNULL_END
