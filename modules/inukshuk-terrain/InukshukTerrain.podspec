Pod::Spec.new do |s|
  s.name = 'InukshukTerrain'
  s.version = '1.0.0'
  s.summary = 'Native 3D terrain inside the MapLibre map for Inukshuk'
  s.description = 'Shared C++ terrain engine + a Metal post-pass driven by an MLNCustomStyleLayer.'
  s.license = { :type => 'MIT' }
  s.author = 'Inukshuk'
  s.homepage = 'https://github.com/MVXTechnologies/inukshuk'
  s.source = { :git => 'https://github.com/MVXTechnologies/inukshuk.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # MapLibre is reached through the Objective-C runtime (no compile-time link):
  # the SPM product is linked into the app by @maplibre/maplibre-react-native.
  s.source_files = 'ios/*.{swift,h,mm}', 'cpp/*.{hpp,cpp}'
  s.public_header_files = 'ios/INKTerrainController.h'
  s.private_header_files = 'cpp/*.hpp'
  s.frameworks = 'Metal', 'MetalKit', 'QuartzCore', 'CoreLocation', 'ImageIO'
  s.libraries = 'z', 'c++'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited)',
  }
end
