// A small, strict PNG decoder for Terrarium DEM tiles: 8-bit gray / RGB /
// RGBA / gray-alpha, non-interlaced, all five filter types. Decoding
// ourselves (zlib inflate + unfilter) keeps the bytes exact on both
// platforms — the OS image decoders may colour-manage, which would corrupt
// the elevation encoding.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace inukshuk::terrain {

struct DecodedImage {
  int width = 0;
  int height = 0;
  /** 3 (RGB) or 4 (RGBA); gray inputs are expanded to RGB(A). */
  int channels = 0;
  std::vector<uint8_t> pixels;
};

/** Decode PNG bytes. On failure returns false and sets `error`. */
bool decodePng(const uint8_t* data, size_t size, DecodedImage& out, std::string& error);

}  // namespace inukshuk::terrain
