#!/bin/sh
set -eu
native_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
validation_binary=$(mktemp -t inukshuk-pdf-validation)
trap 'rm -f "$validation_binary"' EXIT
xcrun swiftc "$native_dir/PdfCropValidation.swift" "$native_dir/PdfJpegCrop.swift" "$native_dir/Tests/main.swift" -o "$validation_binary"
"$validation_binary" "$@"
