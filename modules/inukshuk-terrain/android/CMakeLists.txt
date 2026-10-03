cmake_minimum_required(VERSION 3.22.1)
project(inukshukterrain CXX)

set(CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../cpp)
add_library(inukshukterrain SHARED
  ${CPP_DIR}/terrain_core.cpp
  ${CPP_DIR}/terrain_engine.cpp
  ${CPP_DIR}/terrain_scene.cpp
  ${CPP_DIR}/png_decode.cpp
  ${CPP_DIR}/gles/terrain_gles.cpp)
target_include_directories(inukshukterrain PRIVATE ${CPP_DIR})
target_compile_options(inukshukterrain PRIVATE -Wall)
target_link_libraries(inukshukterrain GLESv3 EGL log z android)
