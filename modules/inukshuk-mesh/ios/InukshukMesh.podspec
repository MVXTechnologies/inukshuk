Pod::Spec.new do |s|
  s.name = 'InukshukMesh'
  s.version = '1.0.0'
  s.summary = 'LAN / hotspot team mesh transport for Inukshuk (#589)'
  s.description = 'Local Expo module: Bonjour discovery and length-prefixed TCP frames on Network.framework.'
  s.license = { :type => 'MIT' }
  s.author = 'Inukshuk'
  s.homepage = 'https://github.com/MVXTechnologies/inukshuk'
  s.source = { :git => 'https://github.com/MVXTechnologies/inukshuk.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  # Top-level sources only: Tests/ is a macOS host test (Tests/run.sh).
  s.source_files = '*.swift'
end
