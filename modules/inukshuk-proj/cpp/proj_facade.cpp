#include "proj_facade.hpp"

#include <proj.h>

#include <cmath>
#include <cstdio>
#include <list>
#include <mutex>
#include <sstream>
#include <unordered_map>
#include <utility>

namespace inkproj {
namespace {

std::mutex gMutex;
PJ_CONTEXT* gCtx = nullptr;
std::vector<std::string> gGridDirs;

// Small LRU of instantiated pipelines (creating one parses the string and
// opens its grids; the Convert screen re-runs the same few on every edit).
constexpr size_t kCacheSize = 16;
std::list<std::pair<std::string, PJ*>> gCache;

void clearCache() {
  for (auto& e : gCache) proj_destroy(e.second);
  gCache.clear();
}

bool fileExists(const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  std::fclose(f);
  return true;
}

// The +grids= names of a pipeline, in order. We never use PROJ's optional
// "@grid" form: a grid the pipeline names is required.
std::vector<std::string> gridNames(const std::string& pipeline) {
  std::vector<std::string> out;
  std::istringstream in(pipeline);
  std::string tok;
  while (in >> tok) {
    const std::string key = "+grids=";
    if (tok.rfind(key, 0) != 0) continue;
    std::string list = tok.substr(key.size());
    size_t start = 0;
    while (start <= list.size()) {
      size_t comma = list.find(',', start);
      std::string g = list.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
      if (!g.empty()) out.push_back(g);
      if (comma == std::string::npos) break;
      start = comma + 1;
    }
  }
  return out;
}

std::vector<GridUse> locate(const std::vector<std::string>& names) {
  std::vector<GridUse> out;
  for (const auto& n : names) {
    GridUse g;
    g.name = n;
    // An absolute path names one exact file (the crop that covers the point).
    if (!n.empty() && n[0] == '/') {
      g.available = fileExists(n);
      if (g.available) g.fullPath = n;
      out.push_back(g);
      continue;
    }
    for (const auto& d : gGridDirs) {
      std::string p = d + "/" + n;
      if (fileExists(p)) {
        g.available = true;
        g.fullPath = p;
        break;
      }
    }
    out.push_back(g);
  }
  return out;
}

PJ* pipelineFor(const std::string& pipeline, std::string* err) {
  for (auto it = gCache.begin(); it != gCache.end(); ++it) {
    if (it->first == pipeline) {
      gCache.splice(gCache.begin(), gCache, it);
      return it->second;
    }
  }
  proj_errno_reset(nullptr);
  PJ* P = proj_create(gCtx, pipeline.c_str());
  if (!P) {
    int e = proj_context_errno(gCtx);
    *err = e ? proj_context_errno_string(gCtx, e) : "proj_create failed";
    return nullptr;
  }
  gCache.emplace_front(pipeline, P);
  if (gCache.size() > kCacheSize) {
    proj_destroy(gCache.back().second);
    gCache.pop_back();
  }
  return P;
}

}  // namespace

InitInfo init(const std::string& projDbPath, const std::vector<std::string>& gridDirs) {
  std::lock_guard<std::mutex> lock(gMutex);
  InitInfo info;
  clearCache();
  if (gCtx) {
    proj_context_destroy(gCtx);
    gCtx = nullptr;
  }
  gCtx = proj_context_create();
  if (!gCtx) {
    info.error = "proj_context_create failed";
    return info;
  }
  // Grids come only from our directories, never the network or a user dir.
  proj_context_set_enable_network(gCtx, 0);
  gGridDirs = gridDirs;
  std::vector<const char*> paths;
  for (const auto& d : gGridDirs) paths.push_back(d.c_str());
  proj_context_set_search_paths(gCtx, static_cast<int>(paths.size()), paths.empty() ? nullptr : paths.data());
  if (!proj_context_set_database_path(gCtx, projDbPath.c_str(), nullptr, nullptr)) {
    info.error = std::string("cannot open proj.db at ") + projDbPath;
    proj_context_destroy(gCtx);
    gCtx = nullptr;
    return info;
  }
  PJ_INFO pi = proj_info();
  info.projVersion = pi.version ? pi.version : "";
  // The returned string lives only until the next call: copy each at once.
  const char* v = proj_context_get_database_metadata(gCtx, "EPSG.VERSION");
  info.epsgVersion = v ? v : "";
  const char* d = proj_context_get_database_metadata(gCtx, "EPSG.DATE");
  info.epsgDate = d ? d : "";
  info.ok = true;
  return info;
}

TransformResult transform(const std::string& pipeline, const std::vector<double>& coords, int dim) {
  std::lock_guard<std::mutex> lock(gMutex);
  TransformResult r;
  r.dim = dim;
  if (!gCtx) {
    r.error = "not-initialized";
    r.message = "PROJ is not initialised";
    return r;
  }
  if (dim < 2 || dim > 4 || coords.empty() || coords.size() % static_cast<size_t>(dim) != 0) {
    r.error = "bad-input";
    r.message = "coordinates must be n × dim with dim 2..4";
    return r;
  }
  r.grids = locate(gridNames(pipeline));
  for (const auto& g : r.grids) {
    if (!g.available) {
      r.error = "missing-grid";
      r.message = "grid not on this device: " + g.name;
      return r;
    }
  }
  std::string err;
  PJ* P = pipelineFor(pipeline, &err);
  if (!P) {
    r.error = "bad-pipeline";
    r.message = err;
    return r;
  }
  r.ballpark = proj_coordoperation_has_ballpark_transformation(gCtx, P) != 0;
  const size_t n = coords.size() / static_cast<size_t>(dim);
  r.coords.resize(coords.size());
  for (size_t i = 0; i < n; ++i) {
    const double* c = &coords[i * dim];
    PJ_COORD in = proj_coord(c[0], c[1], dim > 2 ? c[2] : 0.0, dim > 3 ? c[3] : HUGE_VAL);
    proj_errno_reset(P);
    PJ_COORD out = proj_trans(P, PJ_FWD, in);
    int e = proj_errno(P);
    bool finite = std::isfinite(out.v[0]) && std::isfinite(out.v[1]) && (dim < 3 || std::isfinite(out.v[2]));
    if (e != 0 || !finite) {
      r.error = "point-failed";
      r.message = e ? proj_errno_string(e) : "non-finite result (outside the grid?)";
      r.failedIndex = static_cast<int>(i);
      r.coords.clear();
      return r;
    }
    for (int k = 0; k < dim; ++k) r.coords[i * dim + k] = out.v[k];
  }
  r.ok = true;
  return r;
}

std::vector<GridUse> gridsFor(const std::string& pipeline, std::string* error) {
  std::lock_guard<std::mutex> lock(gMutex);
  if (!gCtx) {
    if (error) *error = "not-initialized";
    return {};
  }
  return locate(gridNames(pipeline));
}

OpInfo epsgOperation(const std::string& code) {
  std::lock_guard<std::mutex> lock(gMutex);
  OpInfo o;
  if (!gCtx) {
    o.error = "not-initialized";
    return o;
  }
  PJ* op = proj_create_from_database(gCtx, "EPSG", code.c_str(), PJ_CATEGORY_COORDINATE_OPERATION, 0, nullptr);
  if (!op) {
    o.error = "unknown EPSG operation " + code;
    return o;
  }
  const char* name = proj_get_name(op);
  o.name = name ? name : "";
  o.accuracy = proj_coordoperation_get_accuracy(gCtx, op);
  o.ballpark = proj_coordoperation_has_ballpark_transformation(gCtx, op) != 0;
  const char* ps = proj_as_proj_string(gCtx, op, PJ_PROJ_5, nullptr);
  o.projString = ps ? ps : "";
  proj_destroy(op);
  o.ok = true;
  return o;
}

TransformResult transformCrs(const std::string& srcCrs, const std::string& dstCrs, const std::vector<double>& coords, int dim) {
  std::lock_guard<std::mutex> lock(gMutex);
  TransformResult r;
  r.dim = dim;
  if (!gCtx) {
    r.error = "not-initialized";
    return r;
  }
  if (dim < 2 || dim > 4 || coords.empty() || coords.size() % static_cast<size_t>(dim) != 0) {
    r.error = "bad-input";
    return r;
  }
  PJ* raw = nullptr;
  if (srcCrs == "BASE") {
    // From the projected CRS's own base geographic CRS: a pure conversion.
    PJ* dst = proj_create(gCtx, dstCrs.c_str());
    PJ* base = dst ? proj_crs_get_geodetic_crs(gCtx, dst) : nullptr;
    if (base && dst) raw = proj_create_crs_to_crs_from_pj(gCtx, base, dst, nullptr, nullptr);
    if (base) proj_destroy(base);
    if (dst) proj_destroy(dst);
  } else {
    raw = proj_create_crs_to_crs(gCtx, srcCrs.c_str(), dstCrs.c_str(), nullptr);
  }
  if (!raw) {
    r.error = "bad-pipeline";
    r.message = "proj_create_crs_to_crs failed";
    return r;
  }
  // lon/lat order, as every pipeline here.
  PJ* P = proj_normalize_for_visualization(gCtx, raw);
  proj_destroy(raw);
  if (!P) {
    r.error = "bad-pipeline";
    return r;
  }
  r.ballpark = proj_coordoperation_has_ballpark_transformation(gCtx, P) != 0;
  const size_t n = coords.size() / static_cast<size_t>(dim);
  r.coords.resize(coords.size());
  for (size_t i = 0; i < n; ++i) {
    const double* c = &coords[i * dim];
    PJ_COORD out = proj_trans(P, PJ_FWD, proj_coord(c[0], c[1], dim > 2 ? c[2] : 0.0, dim > 3 ? c[3] : HUGE_VAL));
    if (!std::isfinite(out.v[0]) || !std::isfinite(out.v[1])) {
      r.error = "point-failed";
      r.failedIndex = static_cast<int>(i);
      r.coords.clear();
      proj_destroy(P);
      return r;
    }
    for (int k = 0; k < dim; ++k) r.coords[i * dim + k] = out.v[k];
  }
  proj_destroy(P);
  r.ok = true;
  return r;
}

}  // namespace inkproj
