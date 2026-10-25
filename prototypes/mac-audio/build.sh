#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The native capture helper can only be built with the macOS SDK on a Mac.' >&2
  exit 1
fi
mkdir -p .local/bin
# No external binary downloads, private APIs, TCC resets, or permission bypasses.
xcrun swiftc -parse-as-library -swift-version 5 -O -target "$(uname -m)-apple-macosx13.0" \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia \
  prototypes/mac-audio/capture.swift -o .local/bin/current-capture
codesign --force --sign - --identifier dev.current.capture .local/bin/current-capture
printf 'Built experimental capture helper. Run only after choosing to grant macOS recording permission.\n'
