Pod::Spec.new do |s|
  s.name           = 'MeroSplitAppIcon'
  s.version        = '1.0.0'
  s.summary        = 'Switches MeroSplit between its primary and alternate iOS app icons.'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'MeroSplit'
  s.homepage       = 'https://merosplit.com'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/omshejul/MeroSplit.com.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
