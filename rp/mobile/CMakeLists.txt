# SPDX-License-Identifier: AGPL-3.0-only
# hsrp: the Remote Play core of the Hóng Sub phone apps (Android, iPhone), built on chiaki-ng's chiaki-lib
# (AGPL-3.0). Only what a phone on the home network needs: no PSN remote connection (holepunch), so no curl,
# json-c, miniupnpc or libevent. Crypto: Mbed TLS (builds the same way for Android, iOS and the computer).
#
#   CHIAKI_DIR   a chiaki-ng checkout with third-party/nanopb, jerasure, gf-complete
#   HSRP_SHARED  ON: libhsrp.so with the JNI entry points (Android)   OFF: static libhsrp.a (iOS)
#   HSRP_TEST    ON: also build hsrp-test, a small program that runs the server (for testing on a computer)
cmake_minimum_required(VERSION 3.16)
project(hsrp C)

set(CHIAKI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../chiaki-ng" CACHE PATH "chiaki-ng source")
option(HSRP_SHARED "Build libhsrp as a shared library (Android)" OFF)
option(HSRP_TEST "Build the hsrp-test program" OFF)
set(CMAKE_C_STANDARD 11)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_package(Python3 REQUIRED COMPONENTS Interpreter)
find_program(PROTOC protoc REQUIRED)

# ---- Mbed TLS 2.28 (what chiaki-lib's mbedtls code is written for) ----
# its CMakeLists asks for a very old CMake, which CMake 4 refuses unless told the oldest policies it may assume
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)
include(FetchContent)
set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
set(USE_SHARED_MBEDTLS_LIBRARY OFF CACHE BOOL "" FORCE)
set(USE_STATIC_MBEDTLS_LIBRARY ON CACHE BOOL "" FORCE)
set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(mbedtls
	GIT_REPOSITORY https://github.com/Mbed-TLS/mbedtls.git
	GIT_TAG v2.28.9
	GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(mbedtls)

# ---- nanopb + the Remote Play protocol messages ----
set(TP "${CHIAKI_DIR}/third-party")
add_subdirectory("${TP}/nanopb" nanopb EXCLUDE_FROM_ALL)
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/takion.pb"
	COMMAND "${PROTOC}" "-o${CMAKE_CURRENT_BINARY_DIR}/takion.pb" "${CHIAKI_DIR}/lib/protobuf/takion.proto" "-I${CHIAKI_DIR}/lib/protobuf"
	MAIN_DEPENDENCY "${CHIAKI_DIR}/lib/protobuf/takion.proto")
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/takion.pb.c" "${CMAKE_CURRENT_BINARY_DIR}/takion.pb.h"
	COMMAND "${Python3_EXECUTABLE}" "${TP}/nanopb/generator/nanopb_generator.py" "${CMAKE_CURRENT_BINARY_DIR}/takion.pb"
	WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}"
	MAIN_DEPENDENCY "${CMAKE_CURRENT_BINARY_DIR}/takion.pb")

# ---- erasure coding (FEC) ----
file(GLOB GF_SRC "${TP}/gf-complete/src/gf.c" "${TP}/gf-complete/src/gf_w*.c" "${TP}/gf-complete/src/gf_rand.c" "${TP}/gf-complete/src/gf_general.c" "${TP}/gf-complete/src/gf_cpu.c")
add_library(hs_gf STATIC ${GF_SRC})
target_include_directories(hs_gf PUBLIC "${TP}/gf-complete/include")
add_library(hs_jerasure STATIC "${TP}/jerasure/src/galois.c" "${TP}/jerasure/src/jerasure.c" "${TP}/jerasure/src/reed_sol.c" "${TP}/jerasure/src/cauchy.c" "${TP}/jerasure/src/liberation.c")
target_include_directories(hs_jerasure PUBLIC "${TP}/jerasure/include")
target_link_libraries(hs_jerasure hs_gf)

# ---- chiaki-lib, home-network part ----
set(L "${CHIAKI_DIR}/lib/src")
# regist.c, with one fix: when it pairs with an unconnected (broadcast) socket it clears the
# port for bind() and never puts it back, so the search goes to port 0 and fails with
# "Can't assign requested address". iPhone needs that path (a connected UDP socket gives
# "Broken pipe" there), so the copy we build sets the PS port back after bind().
file(READ "${L}/regist.c" HS_REGIST)
set(HS_A4 "->sin_addr.s_addr = ip;")
set(HS_A6 "->sin6_addr), &ip, sizeof(struct in6_addr));")
string(FIND "${HS_REGIST}" "${HS_A4}" HS_F4)
string(FIND "${HS_REGIST}" "${HS_A6}" HS_F6)
if(HS_F4 LESS 0 OR HS_F6 LESS 0)
	message(FATAL_ERROR "regist.c changed: the pairing port fix no longer applies")
endif()
string(REPLACE "${HS_A4}" "${HS_A4} ((struct sockaddr_in *)send_addr)->sin_port = htons(REGIST_PORT);" HS_REGIST "${HS_REGIST}")
string(REPLACE "${HS_A6}" "${HS_A6} ((struct sockaddr_in6 *)send_addr)->sin6_port = htons(REGIST_PORT);" HS_REGIST "${HS_REGIST}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/hs_regist.c" "${HS_REGIST}")
set(CHIAKI_SRC
	${L}/common.c ${L}/sock.c ${L}/session.c ${L}/thread.c ${L}/base64.c ${L}/http.c ${L}/log.c ${L}/ctrl.c
	${L}/rpcrypt.c ${L}/takion.c ${L}/senkusha.c ${L}/streamconnection.c ${L}/ecdh.c ${L}/launchspec.c ${L}/random.c
	${L}/gkcrypt.c ${L}/audio.c ${L}/audioreceiver.c ${L}/audiosender.c ${L}/videoreceiver.c ${L}/frameprocessor.c
	${L}/packetstats.c ${L}/discovery.c ${L}/congestioncontrol.c ${L}/stoppipe.c ${L}/reorderqueue.c
	${L}/discoveryservice.c ${L}/feedback.c ${L}/feedbacksender.c ${L}/controller.c ${L}/takionsendbuffer.c
	${L}/time.c ${L}/fec.c "${CMAKE_CURRENT_BINARY_DIR}/hs_regist.c" ${L}/orientation.c ${L}/bitstream.c
	${L}/remote/rudp.c ${L}/remote/rudpsendbuffer.c
	"${CMAKE_CURRENT_BINARY_DIR}/takion.pb.c")
add_library(hs_chiaki STATIC ${CHIAKI_SRC} stubs.c)
target_include_directories(hs_chiaki PUBLIC "${CHIAKI_DIR}/lib/include" "${CMAKE_CURRENT_BINARY_DIR}" "${TP}/nanopb")
target_include_directories(hs_chiaki PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/shim" "${L}")
target_compile_definitions(hs_chiaki PUBLIC CHIAKI_LIB_ENABLE_MBEDTLS PB_C99_STATIC_ASSERT
	CHIAKI_VERSION_MAJOR=1 CHIAKI_VERSION_MINOR=10 CHIAKI_VERSION_PATCH=1 CHIAKI_VERSION="chiaki-ng-1.10.1-hongsub")
target_link_libraries(hs_chiaki protobuf-nanopb-static hs_jerasure mbedtls mbedx509 mbedcrypto)
find_package(Threads REQUIRED)
target_link_libraries(hs_chiaki Threads::Threads)
if(NOT WIN32 AND NOT APPLE AND NOT ANDROID)
	target_link_libraries(hs_chiaki m)
endif()
if(APPLE AND NOT IOS)
	target_link_libraries(hs_chiaki "-framework CoreServices")   # takion.c asks the macOS version (computer test build)
endif()

# ---- the bridge to the app's page ----
if(HSRP_SHARED)
	add_library(hsrp SHARED hsrp.c hslan.c hsnet.c hsrp_jni.c)
	if(ANDROID)
		target_link_libraries(hsrp log)
		target_link_options(hsrp PRIVATE "-Wl,-z,max-page-size=16384")
	endif()
else()
	add_library(hsrp STATIC hsrp.c hslan.c hsnet.c)
endif()
target_link_libraries(hsrp hs_chiaki)
target_include_directories(hsrp PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")

if(HSRP_TEST)
	add_library(hsrp-testlib STATIC hsrp.c hslan.c hsnet.c)
	target_compile_definitions(hsrp-testlib PRIVATE HSRP_TEST_CMDS)
	target_link_libraries(hsrp-testlib hs_chiaki)
	target_include_directories(hsrp-testlib PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
	add_executable(hsrp-test hsrp_test.c)
	target_link_libraries(hsrp-test hsrp-testlib)
endif()
