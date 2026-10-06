// The Convert tool's whole native surface: one PROJ context, explicit
// pipelines only. PROJ never chooses an operation here — the app's
// `src/core/convert/graph.ts` hands in the pinned pipeline string, and this
// layer runs it, reports which grids it used, and fails loudly (never a
// silent no-op) when a grid is missing or a point is outside it.
//
// One implementation for iOS (ObjC++ bridge) and Android (JNI).
#pragma once

#include <string>
#include <vector>

namespace inkproj {

struct InitInfo {
  bool ok = false;
  std::string error;
  std::string projVersion;
  std::string epsgVersion;  // proj.db metadata EPSG.VERSION
  std::string epsgDate;
};

// Opens proj.db and sets the grid search path (the bundled grids first, then
// the downloaded packs). Safe to call again: the context is rebuilt, so a
// grid that arrived since the last call is seen (PROJ caches "not found").
InitInfo init(const std::string& projDbPath, const std::vector<std::string>& gridDirs);

struct GridUse {
  std::string name;  // file name, as in the pipeline (+grids=…)
  bool available = false;
  std::string fullPath;
};

struct TransformResult {
  bool ok = false;
  // Machine code: "not-initialized", "bad-pipeline", "missing-grid",
  // "point-failed" (outside a grid / no data / non-finite), "bad-input".
  std::string error;
  std::string message;
  int dim = 0;
  std::vector<double> coords;  // n points × dim, same layout as the input
  int failedIndex = -1;        // first point that failed
  std::vector<GridUse> grids;
  bool ballpark = false;
};

// `coords`: n points × dim (2, 3 or 4: x y z t). Missing z = 0 and missing
// t = HUGE_VAL, exactly as pyproj does for the reference suite. Every point
// must succeed: a single failure fails the call (refuse rather than guess).
TransformResult transform(const std::string& pipeline, const std::vector<double>& coords, int dim);

// The grids a pipeline references, and whether each is on the device.
std::vector<GridUse> gridsFor(const std::string& pipeline, std::string* error);

struct OpInfo {
  bool ok = false;
  std::string error;
  std::string name;
  double accuracy = -1;  // metres, EPSG-stated; -1 = unknown
  bool ballpark = false;
  std::string projString;
};

// An EPSG coordinate operation from proj.db (name + stated accuracy), so
// the accuracy panel quotes the database, not a copy.
OpInfo epsgOperation(const std::string& code);

// SELF-TEST ONLY (the on-device suite's "family" checks): convert with
// proj.db's own definition of a projected CRS, e.g. EPSG:4617 → EPSG:2951,
// to prove a zone we did not hit with an agency tool uses EPSG's exact
// parameters. Never used for a user conversion (that would be PROJ choosing).
TransformResult transformCrs(const std::string& srcCrs, const std::string& dstCrs, const std::vector<double>& coords, int dim);

}  // namespace inkproj
