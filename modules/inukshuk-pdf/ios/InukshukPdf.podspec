Pod::Spec.new do |s|
  s.name = 'InukshukPdf'
  s.version = '1.0.0'
  s.summary = 'Bounded private PDF crop rendering for Inukshuk'
  s.description = 'Local Expo module for memory-bounded single JPEG PDF crops.'
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
