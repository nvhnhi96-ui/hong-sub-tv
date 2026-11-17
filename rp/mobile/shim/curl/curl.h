/* SPDX-License-Identifier: AGPL-3.0-only
   Hóng Sub phone build: chiaki-lib's certificate helper (aia.h) names curl types, but the phone build has no
   PSN remote connection, so curl is not used. This keeps those declarations compiling. */
#ifndef HSRP_SHIM_CURL_H
#define HSRP_SHIM_CURL_H
typedef void CURL;
#endif
