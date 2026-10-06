#import "INKProj.h"

#include "../cpp/proj_facade.hpp"

static NSBundle *INKProjBundle(void) {
  NSBundle *outer = [NSBundle bundleForClass:[INKProj class]];
  NSURL *url = [outer URLForResource:@"InukshukProj" withExtension:@"bundle"];
  if (url) {
    NSBundle *b = [NSBundle bundleWithURL:url];
    if (b) return b;
  }
  // Static frameworks may land the bundle in the main bundle.
  url = [[NSBundle mainBundle] URLForResource:@"InukshukProj" withExtension:@"bundle"];
  return url ? ([NSBundle bundleWithURL:url] ?: [NSBundle mainBundle]) : [NSBundle mainBundle];
}

static std::vector<double> toVector(NSArray<NSNumber *> *a) {
  std::vector<double> v;
  v.reserve(a.count);
  for (NSNumber *n in a) v.push_back(n.doubleValue);
  return v;
}

static NSString *str(const std::string &s) {
  return [NSString stringWithUTF8String:s.c_str()] ?: @"";
}

static NSDictionary<NSString *, id> *toDict(const inkproj::TransformResult &r) {
  NSMutableArray<NSNumber *> *coords = [NSMutableArray arrayWithCapacity:r.coords.size()];
  for (double d : r.coords) [coords addObject:@(d)];
  NSMutableArray *grids = [NSMutableArray arrayWithCapacity:r.grids.size()];
  for (const auto &g : r.grids) [grids addObject:@{@"name" : str(g.name), @"available" : @(g.available)}];
  return @{
    @"ok" : @(r.ok),
    @"error" : str(r.error),
    @"message" : str(r.message),
    @"coords" : coords,
    @"failedIndex" : @(r.failedIndex),
    @"grids" : grids,
    @"ballpark" : @(r.ballpark),
  };
}

@implementation INKProj

+ (NSDictionary<NSString *, id> *)startWithGridDirs:(NSArray<NSString *> *)gridDirs {
  NSBundle *b = INKProjBundle();
  NSString *db = [b pathForResource:@"proj" ofType:@"db"];
  NSString *bundledGrids = [[b resourcePath] stringByAppendingPathComponent:@"grids"];
  if (!db) return @{@"ok" : @NO, @"error" : @"proj.db is missing from the app bundle"};
  std::vector<std::string> dirs{bundledGrids.UTF8String};
  for (NSString *d in gridDirs) dirs.emplace_back(d.UTF8String);
  auto info = inkproj::init(db.UTF8String, dirs);
  return @{
    @"ok" : @(info.ok),
    @"error" : str(info.error),
    @"projVersion" : str(info.projVersion),
    @"epsgVersion" : str(info.epsgVersion),
    @"epsgDate" : str(info.epsgDate),
    @"bundledGridDir" : bundledGrids,
  };
}

+ (NSDictionary<NSString *, id> *)transform:(NSString *)pipeline
                                     coords:(NSArray<NSNumber *> *)coords
                                        dim:(NSInteger)dim {
  return toDict(inkproj::transform(pipeline.UTF8String, toVector(coords), (int)dim));
}

+ (NSDictionary<NSString *, id> *)transformCrs:(NSString *)src
                                           dst:(NSString *)dst
                                        coords:(NSArray<NSNumber *> *)coords
                                           dim:(NSInteger)dim {
  return toDict(inkproj::transformCrs(src.UTF8String, dst.UTF8String, toVector(coords), (int)dim));
}

+ (NSDictionary<NSString *, id> *)epsgOperation:(NSString *)code {
  auto o = inkproj::epsgOperation(code.UTF8String);
  return @{
    @"ok" : @(o.ok),
    @"error" : str(o.error),
    @"name" : str(o.name),
    @"accuracy" : @(o.accuracy),
    @"ballpark" : @(o.ballpark),
  };
}

@end
