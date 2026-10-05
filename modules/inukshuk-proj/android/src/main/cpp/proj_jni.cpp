// JNI face of the C++ facade (cpp/proj_facade.hpp). Results cross as JSON
// strings (parsed by org.json in Kotlin): one call per conversion, so the
// encoding cost is nothing next to clarity.
#include <jni.h>

#include <cstdio>
#include <string>
#include <vector>

#include "proj_facade.hpp"

namespace {

std::string jstr(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out(c ? c : "");
  if (c) env->ReleaseStringUTFChars(s, c);
  return out;
}

std::string esc(const std::string& s) {
  std::string o = "\"";
  for (char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char b[8];
          std::snprintf(b, sizeof b, "\\u%04x", c);
          o += b;
        } else {
          o += c;
        }
    }
  }
  return o + "\"";
}

std::string num(double d) {
  char b[40];
  std::snprintf(b, sizeof b, "%.17g", d);
  return b;
}

std::string toJson(const inkproj::TransformResult& r) {
  std::string o = "{\"ok\":" + std::string(r.ok ? "true" : "false");
  o += ",\"error\":" + esc(r.error) + ",\"message\":" + esc(r.message);
  o += ",\"failedIndex\":" + std::to_string(r.failedIndex);
  o += ",\"ballpark\":" + std::string(r.ballpark ? "true" : "false");
  o += ",\"coords\":[";
  for (size_t i = 0; i < r.coords.size(); ++i) o += (i ? "," : "") + num(r.coords[i]);
  o += "],\"grids\":[";
  for (size_t i = 0; i < r.grids.size(); ++i) {
    o += (i ? "," : "") + std::string("{\"name\":") + esc(r.grids[i].name) +
         ",\"available\":" + (r.grids[i].available ? "true" : "false") + "}";
  }
  return o + "]}";
}

std::vector<double> doubles(JNIEnv* env, jdoubleArray a) {
  jsize n = env->GetArrayLength(a);
  std::vector<double> v(static_cast<size_t>(n));
  env->GetDoubleArrayRegion(a, 0, n, v.data());
  return v;
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL Java_expo_modules_inukshukproj_ProjNative_init(JNIEnv* env, jclass, jstring db, jobjectArray dirs) {
  std::vector<std::string> d;
  jsize n = env->GetArrayLength(dirs);
  for (jsize i = 0; i < n; ++i) {
    auto s = static_cast<jstring>(env->GetObjectArrayElement(dirs, i));
    d.push_back(jstr(env, s));
    env->DeleteLocalRef(s);
  }
  auto info = inkproj::init(jstr(env, db), d);
  std::string o = "{\"ok\":" + std::string(info.ok ? "true" : "false") + ",\"error\":" + esc(info.error) +
                  ",\"projVersion\":" + esc(info.projVersion) + ",\"epsgVersion\":" + esc(info.epsgVersion) +
                  ",\"epsgDate\":" + esc(info.epsgDate) + "}";
  return env->NewStringUTF(o.c_str());
}

JNIEXPORT jstring JNICALL Java_expo_modules_inukshukproj_ProjNative_transform(JNIEnv* env, jclass, jstring pipeline, jdoubleArray coords, jint dim) {
  auto r = inkproj::transform(jstr(env, pipeline), doubles(env, coords), dim);
  return env->NewStringUTF(toJson(r).c_str());
}

JNIEXPORT jstring JNICALL Java_expo_modules_inukshukproj_ProjNative_transformCrs(JNIEnv* env, jclass, jstring src, jstring dst, jdoubleArray coords, jint dim) {
  auto r = inkproj::transformCrs(jstr(env, src), jstr(env, dst), doubles(env, coords), dim);
  return env->NewStringUTF(toJson(r).c_str());
}

JNIEXPORT jstring JNICALL Java_expo_modules_inukshukproj_ProjNative_epsgOperation(JNIEnv* env, jclass, jstring code) {
  auto o = inkproj::epsgOperation(jstr(env, code));
  std::string s = "{\"ok\":" + std::string(o.ok ? "true" : "false") + ",\"error\":" + esc(o.error) +
                  ",\"name\":" + esc(o.name) + ",\"accuracy\":" + num(o.accuracy) +
                  ",\"ballpark\":" + (o.ballpark ? "true" : "false") + "}";
  return env->NewStringUTF(s.c_str());
}

}  // extern "C"
