Pod::Spec.new do |s|
  s.name = 'InukshukGnss'
  s.version = '1.0.0'
  s.summary = 'Bluetooth byte transport for external GNSS receivers in Inukshuk'
  s.description = 'Local Expo module: CoreBluetooth serial-over-BLE link (Nordic UART and similar) with state restoration, plus a test-only simulated receiver.'
  s.license = { :type => 'MIT' }
  s.author = 'Inukshuk'
  s.homepage = 'https://github.com/MVXTechnologies/inukshuk'
  s.source = { :git => 'https://github.com/MVXTechnologies/inukshuk.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  # Top-level sources only: Tests/ is compiled on the host by Tests/run.sh.
  s.source_files = '*.swift'
end
