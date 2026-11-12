# SPDX-License-Identifier: AGPL-3.0-only
# Builds hongsub-rp against chiaki-ng's chiaki-lib. Put a chiaki-ng checkout (with submodules
# third-party/nanopb, jerasure, gf-complete, curl) in CHIAKI_DIR.
cmake_minimum_required(VERSION 3.16)
project(hongsub_rp C CXX)

set(CHIAKI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/chiaki-ng" CACHE PATH "chiaki-ng source")

set(CHIAKI_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_CLI OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_GUI OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_ANDROID OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_BOREALIS OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_SETSU OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_STEAMDECK_NATIVE OFF CACHE STRING "" FORCE)
set(CHIAKI_LIB_ENABLE_OPUS OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_SPEEX OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_FFMPEG_DECODER OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_PI_DECODER OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_STEAM_SHORTCUT OFF CACHE BOOL "" FORCE)
set(CHIAKI_USE_SYSTEM_JERASURE OFF CACHE STRING "" FORCE)
set(CHIAKI_USE_SYSTEM_NANOPB OFF CACHE STRING "" FORCE)
set(CHIAKI_USE_SYSTEM_CURL OFF CACHE STRING "" FORCE)

add_subdirectory("${CHIAKI_DIR}" chiaki-ng EXCLUDE_FROM_ALL)

add_executable(hongsub-rp main.c)
target_link_libraries(hongsub-rp chiaki-lib)
target_compile_definitions(hongsub-rp PRIVATE CHIAKI_VERSION="chiaki-ng")
if(WIN32)
  target_link_options(hongsub-rp PRIVATE -static-libgcc)
endif()
