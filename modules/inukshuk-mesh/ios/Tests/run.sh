#!/bin/sh
# Host tests for the iOS half of the team mesh (#589): the pure protocol
# (framing, fuzz, buckets, bans, config) and the Network.framework engine over
# real 127.0.0.1 sockets, on macOS. No UIKit or Expo: the module glue is not
# compiled here.
#
#   sh modules/inukshuk-mesh/ios/Tests/run.sh [fuzz-rounds]
set -eu
native_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=$(mktemp -t inukshuk-mesh-tests)
trap 'rm -f "$binary"' EXIT HUP INT TERM
xcrun swiftc -O -swift-version 5 \
  "$native_dir/MeshProtocol.swift" "$native_dir/MeshEngine.swift" "$native_dir/MeshInterfaces.swift" \
  "$native_dir/Tests/MeshProtocolTests.swift" "$native_dir/Tests/MeshEngineTests.swift" "$native_dir/Tests/main.swift" \
  -o "$binary"
"$binary" "$@"
