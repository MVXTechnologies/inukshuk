#!/usr/bin/env bash
# Rasterize the vector brand source (assets/branding/*.svg) into the PNG masters
# that scripts/brand/build-icons.py composites. This is the only non-PIL step:
# headless Chrome renders each SVG at an exact pixel size on a transparent page.
#
#   scripts/brand/render-masters.sh     # writes assets/brand/{background-1024,mark@2x}.png
#
# Then run scripts/brand/build-icons.py to regenerate every icon/splash output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/assets/branding"
OUT="$ROOT/assets/brand"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# render <svg> <width> <height> <out.png>
render() {
  local html="$TMP/$(basename "$4" .png).html"
  printf '<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block;width:%spx;height:%spx}</style></head><body><img src="file://%s"></body></html>' \
    "$2" "$3" "$1" >"$html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --default-background-color=00000000 \
    --window-size="$2,$3" --screenshot="$4" "file://$html" 2>/dev/null
  echo "$4 ${2}x${3}"
}

# The landscape alone, full-bleed, at the icon size (viewBox 1254² -> 1024²).
render "$SRC/inukshuk-background.svg" 1024 1024 "$OUT/background-1024.png"
# The charcoal mark alone at 2x its own 506 x 582.5 box, with alpha.
render "$SRC/inukshuk-mark.svg" 1012 1165 "$OUT/mark@2x.png"
