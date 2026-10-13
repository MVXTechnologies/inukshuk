// Hermes + GWP-ASan repro harness (#648). A plain Android executable that
// makes a Hermes runtime (the same libhermesvm.so the APK ships) and calls
// eval() on fresh source again and again. Each eval compiles on Hermes's
// StackExecutor: a Boost.Context fiber in Meta's build, a real thread in
// ours. Run it with GWP-ASan sampling every allocation
// (scripts/e2e/hermes-gwp-asan/run.sh): every free of a sampled allocation
// walks the frame-pointer chain, so a walk that can run off a fiber stack
// does, within seconds, instead of once in a few hundred app launches.
//
//   eval_stress [evals]
//
// Prints how many GWP-ASan mappings the process has (proof that sampling is
// on), then "done <n>" if every eval ran. A crash is the result under test.
#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <string>

namespace jsi = facebook::jsi;

static int gwpAsanMappings() {
  std::ifstream maps("/proc/self/maps");
  std::string line;
  int n = 0;
  while (std::getline(maps, line)) {
    if (line.find("GWP-ASan") != std::string::npos) n++;
  }
  return n;
}

int main(int argc, char **argv) {
  const int evals = argc > 1 ? std::atoi(argv[1]) : 200;
  std::printf("starting, %d evals\n", evals);
  std::fflush(stdout);
  auto runtime = facebook::hermes::makeHermesRuntime();
  std::printf("gwp-asan mappings: %d\n", gwpAsanMappings());
  std::fflush(stdout);
  // Object literals and nested functions: the compiler paths of the crashes
  // seen in CI (genObjectExpr, genStatement, ...). Every source is new, so
  // nothing is cached.
  const std::string src =
      "var body = '';"
      "for (var i = 0; i < 200; i++) {"
      "  body += 'var o' + i + ' = { a: ' + i + ', b: [1, 2, 3], c: \"s' + i + '\","
      "           f: function (x) { return x + ' + i + '; } }; ';"
      "}"
      "var n = 0;"
      "for (var k = 0; k < " +
      std::to_string(evals) +
      "; k++) {"
      "  n += eval('(function () { ' + body + ' return ' + k + '; })')();"
      "}"
      "n;";
  jsi::Value result =
      runtime->evaluateJavaScript(std::make_shared<jsi::StringBuffer>(src), "eval_stress.js");
  std::printf("done %.0f\n", result.asNumber());
  return 0;
}
