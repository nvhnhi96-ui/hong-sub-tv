#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Build the Remote Play core (../rp/mobile, on chiaki-ng) for iOS as one static library: build-rp/<sdk>/libhsrp_all.a
#   ./build-rp.sh iphoneos | iphonesimulator
set -e
SDK="${1:-iphoneos}"
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/build-rp/cmake-$SDK"
OUT="$HERE/build-rp/$SDK"
if [ "$SDK" = "iphonesimulator" ]; then ARCH="arm64;x86_64"; else ARCH="arm64"; fi
EXTRA=""
[ -n "$HSRP_MBEDTLS_DIR" ] && EXTRA="-DFETCHCONTENT_SOURCE_DIR_MBEDTLS=$HSRP_MBEDTLS_DIR"
[ -n "$HSRP_PYTHON" ] && EXTRA="$EXTRA -DPython3_EXECUTABLE=$HSRP_PYTHON"
cmake -S "$HERE/../rp/mobile" -B "$B" -G "Unix Makefiles" \
  -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT="$SDK" -DCMAKE_OSX_ARCHITECTURES="$ARCH" -DCMAKE_OSX_DEPLOYMENT_TARGET=16.4 \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY -DHSRP_SHARED=OFF \
  -DCHIAKI_DIR="$HERE/../rp/chiaki-ng" $EXTRA
cmake --build "$B" --target hsrp -j 4
mkdir -p "$OUT"
LIBS="$(find "$B" -name '*.a' | grep -E '/(libhsrp|libhs_chiaki|libhs_jerasure|libhs_gf|libprotobuf-nanopb(-static)?|libmbedtls|libmbedx509|libmbedcrypto)\.a$')"
echo "$LIBS"
libtool -static -o "$OUT/libhsrp_all.a" $LIBS
ls -la "$OUT"
