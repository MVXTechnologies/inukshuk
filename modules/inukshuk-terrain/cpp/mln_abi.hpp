// The two MapLibre Native types our Android custom layer exchanges with the
// core, re-declared here so the module needs no MapLibre headers or symbols:
// the core only ever calls a host through its vtable and reads the render
// parameters by field. Layout and virtual order copied from
// include/mln/style/layers/custom_layer_host.hpp and
// custom_layer_render_parameters.hpp at android-v13.6.1 (identical at
// ios-v6.31.0). If the pinned MapLibre version changes, re-check both files.
#pragma once

#include <array>

namespace mln {
namespace gfx {
class Context;
}  // namespace gfx
namespace style {

struct CustomLayerInitParameters {
  virtual ~CustomLayerInitParameters() = default;
};

struct CustomLayerRenderParameters {
  double width;
  double height;
  double latitude;
  double longitude;
  double zoom;
  double bearing;
  double pitch;
  double fieldOfView;
  std::array<double, 16> projectionMatrix;
  std::array<double, 16> nearClippedProjectionMatrix;
};

class CustomLayerHost {
 public:
  virtual ~CustomLayerHost() = default;
  virtual void initialize(const CustomLayerInitParameters&) = 0;
  virtual void preRender(const mln::gfx::Context&, const CustomLayerRenderParameters&) {}
  virtual void render(const CustomLayerRenderParameters&) = 0;
  virtual void contextLost() = 0;
  virtual void deinitialize() = 0;
};

}  // namespace style
}  // namespace mln
