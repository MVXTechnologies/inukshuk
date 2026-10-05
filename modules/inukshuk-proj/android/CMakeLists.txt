cmake_minimum_required(VERSION 3.22.1)
project(inukshukproj CXX)

# PROJ 9.8.1 + libtiff + SQLite as static libs per ABI (scripts/prepare.sh).
set(PREBUILT ${CMAKE_CURRENT_SOURCE_DIR}/../prebuilt/android)
set(CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../cpp)

foreach(lib proj tiff sqlite3)
  add_library(${lib}_static STATIC IMPORTED)
  set_target_properties(${lib}_static PROPERTIES
    IMPORTED_LOCATION ${PREBUILT}/${ANDROID_ABI}/lib/lib${lib}.a)
endforeach()

add_library(inukshukproj SHARED
  ${CPP_DIR}/proj_facade.cpp
  src/main/cpp/proj_jni.cpp)
target_include_directories(inukshukproj PRIVATE ${CPP_DIR} ${PREBUILT}/include)
target_compile_options(inukshukproj PRIVATE -Wall)
# Order matters for static libs: proj needs tiff and sqlite3, tiff needs z.
target_link_libraries(inukshukproj proj_static tiff_static sqlite3_static z log)
# Keep only what JNI reaches (PROJ is large; --gc-sections drops the rest).
target_link_options(inukshukproj PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
