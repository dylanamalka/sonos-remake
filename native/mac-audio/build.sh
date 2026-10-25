#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Native capture requires macOS 13+ and the macOS SDK. No native build was attempted.' >&2
  exit 1
fi
capture_app='.local/mac-capture/CurrentCapture.app'
mkdir -p "$capture_app/Contents/MacOS"
xcrun clang -fobjc-arc -target "$(uname -m)-apple-macosx13.0" -c native/mac-audio/BrowserFilter.m -o .local/mac-capture/BrowserFilter.o
xcrun swiftc -import-objc-header native/mac-audio/BrowserFilter.h .local/mac-capture/BrowserFilter.o -parse-as-library -swift-version 5 -O -target "$(uname -m)-apple-macosx13.0" \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreGraphics \
  native/mac-audio/capture.swift -o "$capture_app/Contents/MacOS/CurrentCapture"
cat > "$capture_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CurrentCapture</string>
<key>CFBundleIdentifier</key><string>dev.current.capture</string>
<key>CFBundleName</key><string>Current Audio Capture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSUIElement</key><true/>
<key>NSAudioCaptureUsageDescription</key><string>Stream your chosen browser's audio to the Sonos rooms you select in Current.</string>
</dict></plist>
PLIST
codesign --force --sign - --identifier dev.current.capture "$capture_app"
# No permission bypass, TCC edits, binary downloads, or privileged installation.
cat native/mac-audio/capture.swift native/mac-audio/BrowserFilter.h native/mac-audio/BrowserFilter.m | shasum -a 256 | awk '{print $1}' > .local/mac-capture/source.sha256
printf 'Built Current Audio Capture locally. Recording consent is requested only when streaming starts.\n'
