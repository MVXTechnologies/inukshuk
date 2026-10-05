Pod::Spec.new do |s|
  s.name = 'InukshukProj'
  s.version = '1.0.0'
  s.summary = 'PROJ 9.8.1 for the Inukshuk Convert tool (pinned pipelines only)'
  s.description = 'A thin C++ facade over static PROJ + libtiff (no curl), proj.db and two bundled grids.'
  s.license = { :type => 'MIT' }
  s.author = 'Inukshuk'
  s.homepage = 'https://github.com/MVXTechnologies/inukshuk'
  s.source = { :git => 'https://github.com/MVXTechnologies/inukshuk.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # Built by scripts/prepare.sh (scripts/build-proj.sh): PROJ 9.8.1 + libtiff
  # 4.7.1 as static xcframeworks, ios-arm64 + ios-arm64-simulator.
  s.vendored_frameworks = 'prebuilt/ios/Proj.xcframework', 'prebuilt/ios/Tiff.xcframework'
  s.source_files = 'ios/*.{swift,h,mm}', 'cpp/*.{hpp,cpp}'
  s.public_header_files = 'ios/INKProj.h'
  s.private_header_files = 'cpp/*.hpp'
  # proj.db + EGM96 + the NAD83(CSRS) v7 velocity grid, read in place from the bundle.
  s.resource_bundles = { 'InukshukProj' => ['assets/inukshukproj/proj.db', 'assets/inukshukproj/grids'] }
  # The system SQLite and zlib (PROJ links both).
  s.libraries = 'sqlite3', 'z', 'c++'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"${PODS_TARGET_SRCROOT}/prebuilt/ios/include"',
  }
end
