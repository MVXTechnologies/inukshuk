// C++ twins of src/core/terrain3d/{contours3d,surface,labels,lines}.ts — the
// 3D scene maths (owner, #551: no draping). Parity: tests/terrain_tests.cpp.
#include <algorithm>
#include <cmath>
#include <unordered_set>

#include "terrain_core.hpp"

namespace inukshuk::terrain {

namespace {
// JavaScript's Math.round (half toward +∞).
inline double jsRound(double x) { return std::floor(x + 0.5); }
inline double mixd(double a, double b, double t) { return a + (b - a) * clamp01(t); }
inline Rgb mixRgb(const Rgb& a, const Rgb& b, double t) {
  return {mixd(a[0], b[0], t), mixd(a[1], b[1], t), mixd(a[2], b[2], t)};
}
}  // namespace

// ---- contours ------------------------------------------------------------------

std::pair<double, double> contourLevelsForZoom(double zoom) {
  const int z = static_cast<int>(std::floor(zoom));
  if (z <= 9) return {100, 500};
  if (z == 10) return {50, 250};
  if (z == 11) return {25, 100};
  if (z == 12) return {20, 100};
  return {10, 50};
}

int baseLevelIndex(double zoom) {
  const double minor = contourLevelsForZoom(zoom).first;
  for (int i = 0; i < kLevelCount; i++)
    if (kLevelLadder[i][0] == minor) return i;
  return 0;
}

std::pair<int, double> levelForDensity(int base, double dhPerPx) {
  const double d = std::max(std::abs(dhPerPx), 1e-6);
  const int b = std::max(0, base);
  for (int i = b; i < kLevelCount; i++) {
    const double spacing = kLevelLadder[i][0] / d;
    if (spacing >= kMinSpacingPx) {
      if (i == b) return {i, 0.0};
      const double finer = kLevelLadder[i - 1][0] / d;
      const double t = std::min(std::max((finer - (kMinSpacingPx - 2)) / 2, 0.0), 1.0);
      return {i, t};
    }
  }
  return {kLevelCount - 1, 0.0};
}

double distanceToLevelPx(double h, double interval, double dhPerPx) {
  const double v = h / interval;
  const double f = std::abs(v - jsRound(v));
  return f * interval / std::max(std::abs(dhPerPx), 1e-6);
}

double lineCoverage(double distPx, double widthPx) {
  return std::min(std::max(widthPx / 2 + 0.5 - distPx, 0.0), 1.0);
}

bool isMajorLevel(double h, double minor, double major) {
  const long k = static_cast<long>(jsRound(h / minor));
  const long every = static_cast<long>(jsRound(major / minor));
  return ((k % every) + every) % every == 0;
}

std::pair<double, double> contourAt(double h, double dhPerPx, double zoom) {
  const auto [index, finerWeight] = levelForDensity(baseLevelIndex(zoom), dhPerPx);
  auto sample = [&](int i) {
    const double minor = kLevelLadder[i][0], major = kLevelLadder[i][1];
    const double maj = lineCoverage(distanceToLevelPx(h, major, dhPerPx), kMajorWidthPx);
    const double mn = isMajorLevel(h, minor, major)
                          ? 0.0
                          : lineCoverage(distanceToLevelPx(h, minor, dhPerPx), kMinorWidthPx);
    return std::make_pair(mn, maj);
  };
  const auto coarse = sample(index);
  if (finerWeight <= 0 || index == 0) return coarse;
  const auto fine = sample(index - 1);
  return {std::max(coarse.first, fine.first * finerWeight),
          std::max(coarse.second, fine.second * finerWeight)};
}

// ---- surface -----------------------------------------------------------------------

double lambertFor(double slopeX, double slopeY, double exaggeration, const Vec3& light) {
  const double nx = -slopeX * exaggeration, ny = -slopeY * exaggeration;
  const double len = std::hypot(nx, ny, 1.0);
  return std::max(0.0, (nx * light[0] + ny * light[1] + light[2]) / len);
}

Rgb shadeSurface(const SurfacePalette& pal, const SurfaceParams& s, double heightM, double slopeX,
                 double slopeY, double exaggeration, const Vec3& light, double water,
                 double glacier) {
  const double rock = smoothstep(s.rockStartM, s.rockFullM, heightM) * s.rockMax;
  Rgb c = mixRgb(pal.land, pal.rock, rock);
  c = mixRgb(c, pal.glacier, glacier);
  const double w = std::max(water, heightM <= 0.5 ? 1.0 : 0.0);
  c = mixRgb(c, pal.water, w);
  const double lambert = lambertFor(slopeX, slopeY, exaggeration, light);
  const double flat = light[2];
  const double away = clamp01((flat - lambert) / std::max(flat, 1e-6));
  const double lit = clamp01((lambert - s.highlightFrom) / (1 - s.highlightFrom));
  const double grad = std::hypot(slopeX, slopeY) * exaggeration;
  const double steep = smoothstep(0.4, 1.6, grad) * s.slopeDarken * (1 - lit);
  const double shadeK = (1 - w) * clamp01(away * s.shadowStrength + steep);
  c = mixRgb(c, pal.shadow, shadeK);
  c = mixRgb(c, pal.highlight, (1 - w) * lit * s.highlightStrength);
  return c;
}

// ---- labels ------------------------------------------------------------------------

double labelScale(double distance, double ctc) {
  if (!(distance > 0)) return 1;
  return std::min(1.0, std::max(0.6, 1.25 * ctc / distance));
}

bool rectsOverlap(const std::array<double, 4>& a, const std::array<double, 4>& b, double pad) {
  // {x0, y0, x1, y1}
  return a[0] - pad < b[2] && b[0] - pad < a[2] && a[1] - pad < b[3] && b[1] - pad < a[3];
}

double stepOpacity(double current, double target, double dtMs, double fadeMs) {
  if (fadeMs <= 0) return target;
  const double step = std::max(0.0, dtMs) / fadeMs;
  return current < target ? std::min(target, current + step) : std::max(target, current - step);
}

bool occludedByTerrain(const Vec3& eye, const Vec3& anchor,
                       const std::function<std::optional<double>(double, double)>& terrainZ,
                       int steps, double clearanceM) {
  for (int i = 1; i < steps; i++) {
    const double t = static_cast<double>(i) / steps;
    if (t > 0.97) break;
    const double x = eye[0] + (anchor[0] - eye[0]) * t;
    const double y = eye[1] + (anchor[1] - eye[1]) * t;
    const double z = eye[2] + (anchor[2] + clearanceM - eye[2]) * t;
    const auto g = terrainZ(x, y);
    if (g && *g > z) return true;
  }
  return false;
}

std::vector<PlacedLabel> placeLabels(const std::vector<LabelInput>& inputs,
                                     std::unordered_map<int, LabelState>& states,
                                     const PlaceOptions& o) {
  const double fadeFrom = o.fadeFromCtc * o.ctc, fadeTo = o.fadeToCtc * o.ctc;
  struct Cand {
    const LabelInput* l;
    double ndc0, ndc1, w, gx, gy, scale, distFade;
  };
  std::vector<Cand> cands;
  cands.reserve(inputs.size());
  const Mat4& P = o.P;
  for (const auto& l : inputs) {
    const double z = (l.h - o.hRef) * o.heightScale;
    const Vec4 v = transform(P, {l.x, l.y, z, 1});
    if (v[3] <= 1e-9) continue;
    const double n0 = v[0] / v[3], n1 = v[1] / v[3];
    if (std::abs(n0) > 1.15 || n1 < -1.15 || n1 > 1.4) continue;
    const double w = v[3];
    const double scale = labelScale(w, o.ctc);
    const double distFade =
        1 - std::min(std::max((w - fadeFrom) / std::max(fadeTo - fadeFrom, 1.0), 0.0), 1.0);
    if (distFade <= 0) continue;
    cands.push_back({&l, n0, n1, w, (n0 * 0.5 + 0.5) * o.width, (0.5 - n1 * 0.5) * o.height,
                     scale, distFade});
  }
  // Stable ranking (labels.ts): priority, a shown pin's stickiness, then id.
  auto rank = [&](const Cand& c) {
    auto it = states.find(c.l->id);
    return c.l->priority - (it != states.end() && it->second.shown ? kLabelSticky : 0.0);
  };
  std::stable_sort(cands.begin(), cands.end(), [&](const Cand& a, const Cand& b) {
    const double ra = rank(a), rb = rank(b);
    if (ra != rb) return ra < rb;
    return a.l->id < b.l->id;
  });
  std::vector<std::array<double, 4>> taken;
  std::vector<PlacedLabel> out;
  std::unordered_set<int> seen;
  for (const auto& c : cands) {
    seen.insert(c.l->id);
    auto it = states.find(c.l->id);
    LabelState st = it == states.end() ? LabelState{} : it->second;
    const double w = c.l->w * c.scale, h = c.l->ph * c.scale, stem = o.stemPx * c.scale;
    const std::array<double, 4> r = {c.gx - w / 2, c.gy - stem - h, c.gx + w / 2, c.gy - stem};
    const double slack = st.shown ? kLabelEdgeSlackPx : 0;
    const bool clearTop = o.topPx > 0 ? r[1] >= o.topPx - slack : r[3] > 0;
    const bool clearBottom = o.bottomPx > 0 ? r[3] <= o.height - o.bottomPx + slack : r[1] < o.height;
    const bool onScreen = r[2] > -slack && r[0] < o.width + slack && clearTop && clearBottom;
    bool fits = onScreen && static_cast<int>(taken.size()) < o.maxLabels;
    if (fits) {
      for (const auto& t : taken) {
        if (rectsOverlap(r, t, o.padPx)) {
          fits = false;
          break;
        }
      }
    }
    if (fits && o.occluded && o.occluded(*c.l)) fits = false;
    // Hysteresis: a shown pin keeps its place through a brief loss of it.
    bool want = fits;
    if (fits) {
      st.blockedAt = std::numeric_limits<double>::quiet_NaN();
    } else if (st.shown && onScreen) {
      if (std::isnan(st.blockedAt)) st.blockedAt = o.nowMs;
      want = o.nowMs - st.blockedAt < kLabelHoldMs;
    }
    if (want != st.shown && o.toggles) (*o.toggles)++;
    st.shown = want;
    if (!want) st.blockedAt = std::numeric_limits<double>::quiet_NaN();
    if (want) {
      taken.push_back(r);
      st.shownAt = o.nowMs;
    }
    st.opacity = stepOpacity(st.opacity, want ? 1 : 0, o.dtMs, o.fadeMs);
    states[c.l->id] = st;
    if (st.opacity > 0) {
      out.push_back({c.l->id, c.ndc0, c.ndc1, c.w, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2, c.gx, c.gy,
                     c.scale, st.opacity * c.distFade});
    }
  }
  for (auto it = states.begin(); it != states.end();) {
    if (seen.count(it->first)) {
      ++it;
      continue;
    }
    if (it->second.shown && o.toggles) (*o.toggles)++;
    it->second.shown = false;
    it->second.blockedAt = std::numeric_limits<double>::quiet_NaN();
    it->second.opacity = stepOpacity(it->second.opacity, 0, o.dtMs, o.fadeMs);
    if (it->second.opacity <= 0)
      it = states.erase(it);
    else
      ++it;
  }
  std::stable_sort(out.begin(), out.end(),
                   [](const PlacedLabel& a, const PlacedLabel& b) { return a.depth > b.depth; });
  return out;
}

// ---- lines / masks -----------------------------------------------------------------------

std::vector<Pt> densify(const std::vector<Pt>& pts, double maxStep) {
  std::vector<Pt> out;
  for (size_t i = 0; i < pts.size(); i++) {
    const Pt& p = pts[i];
    if (i > 0) {
      const Pt& q = pts[i - 1];
      const double d = std::hypot(p[0] - q[0], p[1] - q[1]);
      const int n = static_cast<int>(std::min(256.0, std::ceil(d / std::max(maxStep, 1e-12))));
      for (int k = 1; k < n; k++) {
        const double t = static_cast<double>(k) / n;
        out.push_back({q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t});
      }
    }
    out.push_back(p);
  }
  return out;
}

std::array<double, 2> extrudeOffset(const Pt& a, const Pt& b, double side, double widthPx,
                                    const Pt& viewport) {
  const double dx = (b[0] - a[0]) * viewport[0], dy = (b[1] - a[1]) * viewport[1];
  const double len = std::hypot(dx, dy);
  if (len < 1e-9) return {0, 0};
  const double nx = -dy / len, ny = dx / len;
  return {nx * widthPx / viewport[0] * side, ny * widthPx / viewport[1] * side};
}

std::vector<uint8_t> rasterizePolygons(const std::vector<std::vector<Pt>>& rings, int size) {
  std::vector<uint8_t> out(static_cast<size_t>(size) * size, 0);
  std::vector<double> xs;
  for (int row = 0; row < size; row++) {
    const double y = (row + 0.5) / size;
    xs.clear();
    for (const auto& ring : rings) {
      const size_t n = ring.size();
      for (size_t i = 0; i < n; i++) {
        const Pt& a = ring[i];
        const Pt& b = ring[(i + 1) % n];
        if ((a[1] <= y) == (b[1] <= y)) continue;
        xs.push_back(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
    }
    std::sort(xs.begin(), xs.end());
    for (size_t k = 0; k + 1 < xs.size(); k += 2) {
      const int c0 = std::max(0, static_cast<int>(std::ceil(xs[k] * size - 0.5)));
      const int c1 = std::min(size - 1, static_cast<int>(std::floor(xs[k + 1] * size - 0.5)));
      for (int c = c0; c <= c1; c++) out[static_cast<size_t>(row) * size + c] = 255;
    }
  }
  return out;
}

}  // namespace inukshuk::terrain
