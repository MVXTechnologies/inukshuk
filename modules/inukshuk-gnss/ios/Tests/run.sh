#!/bin/sh
# Host tests of the module's pure Swift (GnssCore.swift) and the NTRIP TCP
# pipe (GnssTcpPipe.swift, against a loopback echo server); no simulator.
set -eu
native_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=$(mktemp -t inukshuk-gnss-core)
trap 'rm -f "$binary"' EXIT
xcrun swiftc "$native_dir/GnssCore.swift" "$native_dir/GnssTcpPipe.swift" "$native_dir/Tests/TcpTests.swift" "$native_dir/Tests/main.swift" -o "$binary"
"$binary"
