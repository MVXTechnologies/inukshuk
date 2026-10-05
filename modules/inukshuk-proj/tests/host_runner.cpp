// The Convert facade on the build machine: the same proj_facade.cpp and PROJ
// 9.8.1 as the app, driven by a line protocol so the TypeScript suite
// (src/core/convert/nativeSuite.ts) can run the reference points without a
// simulator. Used by tests/run-host.sh and CI.
//
//   host_runner <proj.db> <gridDir> [<gridDir>…]   < requests > responses
//
// Requests (tab-separated, one per line):
//   T <dim> <c1 c2 …> <pipeline>        transform
//   E <code>                             EPSG operation info
//   C <dim> <c1 c2 …> <srcCrs> <dstCrs>  CRS-to-CRS (self-test family checks)
// Responses: "OK\t<r1 r2 …>" | "OK\t<accuracy>\t<name>" | "ERR\t<code>\t<message>"
#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "../cpp/proj_facade.hpp"

static std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> out;
  std::string cur;
  for (char c : s) {
    if (c == sep) {
      out.push_back(cur);
      cur.clear();
    } else {
      cur.push_back(c);
    }
  }
  out.push_back(cur);
  return out;
}

static std::vector<double> nums(const std::string& s) {
  std::vector<double> v;
  std::istringstream in(s);
  double d;
  while (in >> d) v.push_back(d);
  return v;
}

static void emit(const inkproj::TransformResult& r) {
  if (!r.ok) {
    std::cout << "ERR\t" << r.error << "\t" << r.message << "\n";
    return;
  }
  std::cout << "OK\t";
  char buf[64];
  for (size_t i = 0; i < r.coords.size(); ++i) {
    std::snprintf(buf, sizeof buf, "%.17g", r.coords[i]);
    std::cout << (i ? " " : "") << buf;
  }
  std::cout << "\n";
}

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: host_runner proj.db gridDir...\n";
    return 2;
  }
  std::vector<std::string> dirs(argv + 2, argv + argc);
  auto info = inkproj::init(argv[1], dirs);
  if (!info.ok) {
    std::cerr << info.error << "\n";
    return 1;
  }
  std::cerr << "PROJ " << info.projVersion << ", EPSG " << info.epsgVersion << "\n";
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    auto f = split(line, '\t');
    if (f[0] == "T" && f.size() >= 4) {
      emit(inkproj::transform(f[3], nums(f[2]), std::stoi(f[1])));
    } else if (f[0] == "C" && f.size() >= 5) {
      emit(inkproj::transformCrs(f[3], f[4], nums(f[2]), std::stoi(f[1])));
    } else if (f[0] == "E" && f.size() >= 2) {
      auto o = inkproj::epsgOperation(f[1]);
      if (o.ok) {
        std::cout << "OK\t" << o.accuracy << "\t" << o.name << "\n";
      } else {
        std::cout << "ERR\tunknown\t" << o.error << "\n";
      }
    } else {
      std::cout << "ERR\tbad-request\t" << f[0] << "\n";
    }
    std::cout.flush();
  }
  return 0;
}
