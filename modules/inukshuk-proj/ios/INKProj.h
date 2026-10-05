#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// ObjC face of the C++ facade (cpp/proj_facade.hpp) for the Swift module.
/// Every call is synchronous and thread-safe (the facade holds one mutex).
@interface INKProj : NSObject

/// Opens proj.db from the resource bundle; grid search path = the bundled
/// grids first, then `gridDirs` (downloaded packs).
+ (NSDictionary<NSString *, id> *)startWithGridDirs:(NSArray<NSString *> *)gridDirs;

+ (NSDictionary<NSString *, id> *)transform:(NSString *)pipeline
                                     coords:(NSArray<NSNumber *> *)coords
                                        dim:(NSInteger)dim;

+ (NSDictionary<NSString *, id> *)transformCrs:(NSString *)src
                                           dst:(NSString *)dst
                                        coords:(NSArray<NSNumber *> *)coords
                                           dim:(NSInteger)dim;

+ (NSDictionary<NSString *, id> *)epsgOperation:(NSString *)code;

@end

NS_ASSUME_NONNULL_END
