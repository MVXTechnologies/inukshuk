#include "png_decode.hpp"

#include <zlib.h>

#include <cstdlib>
#include <cstring>

namespace inukshuk::terrain {

namespace {

uint32_t be32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

int paeth(int a, int b, int c) {
  const int p = a + b - c;
  const int pa = std::abs(p - a), pb = std::abs(p - b), pc = std::abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

bool inflateAll(const std::vector<uint8_t>& in, std::vector<uint8_t>& out, size_t expected) {
  out.resize(expected);
  z_stream zs;
  std::memset(&zs, 0, sizeof(zs));
  if (inflateInit(&zs) != Z_OK) return false;
  zs.next_in = const_cast<Bytef*>(in.data());
  zs.avail_in = static_cast<uInt>(in.size());
  zs.next_out = out.data();
  zs.avail_out = static_cast<uInt>(out.size());
  const int rc = inflate(&zs, Z_FINISH);
  const size_t produced = zs.total_out;
  inflateEnd(&zs);
  return (rc == Z_STREAM_END || rc == Z_OK || rc == Z_BUF_ERROR) && produced == expected;
}

}  // namespace

bool decodePng(const uint8_t* data, size_t size, DecodedImage& out, std::string& error) {
  static const uint8_t kSig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  if (size < 8 || std::memcmp(data, kSig, 8) != 0) {
    error = "not a PNG";
    return false;
  }
  size_t pos = 8;
  int width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  std::vector<uint8_t> idat;
  bool sawIhdr = false, sawIend = false;
  while (pos + 12 <= size) {
    const uint32_t len = be32(data + pos);
    const uint8_t* type = data + pos + 4;
    if (len > size - pos - 12) {
      error = "truncated chunk";
      return false;
    }
    const uint8_t* body = data + pos + 8;
    if (std::memcmp(type, "IHDR", 4) == 0) {
      if (len < 13) {
        error = "bad IHDR";
        return false;
      }
      width = static_cast<int>(be32(body));
      height = static_cast<int>(be32(body + 4));
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
      sawIhdr = true;
    } else if (std::memcmp(type, "IDAT", 4) == 0) {
      idat.insert(idat.end(), body, body + len);
    } else if (std::memcmp(type, "IEND", 4) == 0) {
      sawIend = true;
      break;
    }
    pos += 12 + len;
  }
  if (!sawIhdr || idat.empty()) {
    error = "missing IHDR/IDAT";
    return false;
  }
  (void)sawIend;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    error = "bad size";
    return false;
  }
  if (bitDepth != 8 || interlace != 0) {
    error = "unsupported bit depth / interlace";
    return false;
  }
  int bpp;  // bytes per source pixel
  switch (colorType) {
    case 0:
      bpp = 1;
      break;  // gray
    case 2:
      bpp = 3;
      break;  // RGB
    case 4:
      bpp = 2;
      break;  // gray + alpha
    case 6:
      bpp = 4;
      break;  // RGBA
    default:
      error = "unsupported colour type";
      return false;
  }
  const size_t stride = static_cast<size_t>(width) * bpp;
  std::vector<uint8_t> raw;
  if (!inflateAll(idat, raw, (stride + 1) * static_cast<size_t>(height))) {
    error = "inflate failed";
    return false;
  }
  std::vector<uint8_t> img(stride * static_cast<size_t>(height));
  for (int y = 0; y < height; y++) {
    const uint8_t filter = raw[y * (stride + 1)];
    const uint8_t* src = raw.data() + y * (stride + 1) + 1;
    uint8_t* dst = img.data() + y * stride;
    const uint8_t* prev = y > 0 ? img.data() + (y - 1) * stride : nullptr;
    for (size_t i = 0; i < stride; i++) {
      const int a = i >= static_cast<size_t>(bpp) ? dst[i - bpp] : 0;
      const int b = prev ? prev[i] : 0;
      const int c = (prev && i >= static_cast<size_t>(bpp)) ? prev[i - bpp] : 0;
      int v;
      switch (filter) {
        case 0:
          v = src[i];
          break;
        case 1:
          v = src[i] + a;
          break;
        case 2:
          v = src[i] + b;
          break;
        case 3:
          v = src[i] + ((a + b) >> 1);
          break;
        case 4:
          v = src[i] + paeth(a, b, c);
          break;
        default:
          error = "bad filter";
          return false;
      }
      dst[i] = static_cast<uint8_t>(v & 0xff);
    }
  }
  out.width = width;
  out.height = height;
  if (colorType == 2 || colorType == 6) {
    out.channels = bpp;
    out.pixels = std::move(img);
    return true;
  }
  // Expand gray (+alpha) to RGB(A).
  const bool alpha = colorType == 4;
  out.channels = alpha ? 4 : 3;
  out.pixels.resize(static_cast<size_t>(width) * height * out.channels);
  for (size_t i = 0, n = static_cast<size_t>(width) * height; i < n; i++) {
    const uint8_t g = img[i * bpp];
    uint8_t* d = out.pixels.data() + i * out.channels;
    d[0] = d[1] = d[2] = g;
    if (alpha) d[3] = img[i * bpp + 1];
  }
  return true;
}

}  // namespace inukshuk::terrain
