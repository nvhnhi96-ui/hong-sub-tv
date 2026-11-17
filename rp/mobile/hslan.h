/* SPDX-License-Identifier: AGPL-3.0-only
 * hslan: the phone as the "computer" for the Hóng Sub app on a TV LG (webOS) or TV Samsung (Tizen).
 * The TV app asks for the next line straight over the home network (GET /sub?code=..&since=.., long poll),
 * exactly as it asks Hóng Sub on a computer (pc/lg.js), so it does not wait on honggame.store.
 * Also finds those TVs on the home network (SSDP answers and the ports they keep open). */
#ifndef HSLAN_H
#define HSLAN_H
#include <stddef.h>

#define HSLAN_PORT 8767

/* starts the server if it is not running; returns its port (0: could not start).
   ips: this phone's home-network addresses, comma separated, the best one first */
int hslan_on(char *ips, size_t ips_size);
/* a message (a JSON object) for the TV app showing this code */
void hslan_push(const char *code, const char *json);
/* how long ago (ms) the TV app with this code last asked, -1: never; ver: its build */
long long hslan_seen(const char *code, char *ver, size_t ver_size);
/* codes of the TV apps that asked in the last 30 s, comma separated */
void hslan_codes(char *out, size_t out_size);
/* TVs LG / Samsung on the home network, as JSON: {"ev":"lanfind","list":[{"addr":..,"ports":[..],"text":".."}]} */
void hslan_find(int ms, char *out, size_t out_size);

#endif
