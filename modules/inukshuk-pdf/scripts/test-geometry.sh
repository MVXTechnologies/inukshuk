#!/bin/sh
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
classes_dir=$(mktemp -d)
trap 'rm -rf "$classes_dir"' EXIT HUP INT TERM
javac -d "$classes_dir" \
  "$module_dir/android/src/main/java/expo/modules/inukshukpdf/CropGeometry.java" \
  "$module_dir/android/src/test/java/expo/modules/inukshukpdf/CropGeometryTest.java" \
  "$module_dir/android/src/main/java/expo/modules/inukshukpdf/PrivatePdfFiles.java" \
  "$module_dir/android/src/test/java/expo/modules/inukshukpdf/PrivatePdfFilesTest.java"
java -cp "$classes_dir" expo.modules.inukshukpdf.CropGeometryTest

java -cp "$classes_dir" expo.modules.inukshukpdf.PrivatePdfFilesTest
