Pod::Spec.new do |s|
  s.name = 'InukshukMapPitch'
  s.version = '1.0.0'
  s.summary = 'Raises the maximum camera pitch of the MapLibre maps on screen'
  s.description = 'Local Expo module: sets maximumPitch on every MLNMapView in the window (#480).'
  s.license = { :type => 'MIT' }
  s.author = 'Inukshuk'
  s.homepage = 'https://github.com/MVXTechnologies/inukshuk'
  s.source = { :git => 'https://github.com/MVXTechnologies/inukshuk.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '*.swift'
end
