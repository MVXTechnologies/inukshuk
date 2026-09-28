#!/bin/sh
# Build MapLibre glyphs (SDF PBF ranges) for Atkinson Hyperlegible Next and
# upload them to R2 under fonts/, where the Worker serves
# /fonts/{fontstack}/{range}.pbf. Run once (and again only if the font
# changes). Needs Docker; everything runs in containers.
#
#   R2_ACCOUNT_ID=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./build-glyphs.sh
#
# Font stacks produced (must match STONE_FONTS_ATKINSON in
# src/core/map/stoneStyle.ts): "Atkinson Hyperlegible Next Regular",
# "... Bold", "... Italic". Licence: SIL OFL 1.1.
set -eu

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
BUCKET=${R2_BUCKET:-inukshuk-tiles}
WORK=${WORK:-$HOME/inukshuk-glyphs}
SRC=https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/main/fonts/ttf

mkdir -p "$WORK/ttf" "$WORK/out"
for style in Regular Bold Italic; do
  curl -fsSL -o "$WORK/ttf/AtkinsonHyperlegibleNext-$style.ttf" "$SRC/AtkinsonHyperlegibleNext-$style.ttf"
done

docker run --rm -v "$WORK:/work" rust:1 sh -c \
  'cargo install --quiet build_pbf_glyphs && build_pbf_glyphs /work/ttf /work/out'

# build_pbf_glyphs names each folder after the FILE (AtkinsonHyperlegibleNext-Regular);
# the style asks for "Atkinson Hyperlegible Next Regular". Keep only ranges that hold
# glyphs (~10 per font) — the Worker answers any other range with an empty message.
mkdir -p "$WORK/upload"
for style in Regular Bold Italic; do
  dest="$WORK/upload/Atkinson Hyperlegible Next $style"
  mkdir -p "$dest"
  find "$WORK/out/AtkinsonHyperlegibleNext-$style" -name '*.pbf' -size +100c -exec cp {} "$dest/" \;
done
ls "$WORK/upload"

docker run --rm -v "$WORK/upload:/glyphs:ro" \
  -e RCLONE_CONFIG_R2_TYPE=s3 -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  -e RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  -e RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
  rclone/rclone:1 copy /glyphs "r2:$BUCKET/fonts" --transfers 16

echo "Glyphs uploaded to $BUCKET/fonts/"
