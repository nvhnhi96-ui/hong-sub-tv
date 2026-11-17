/* SPDX-License-Identifier: AGPL-3.0-only
 * hsrp: Remote Play core of the Hóng Sub phone apps, built on chiaki-ng's chiaki-lib (AGPL-3.0).
 *
 * The app's page talks to it over a WebSocket on 127.0.0.1 (ws://127.0.0.1:<port>/ws?t=<token>):
 *   page -> core (text):  regist <host> <ps5 0|1> <account_b64> <pin>
 *                         stream <host> <ps5 0|1> <regist_key_b64> <morning_b64> <res> <fps> [kbps]
 *                         c <buttons> <l2> <r2> <lx> <ly> <rx> <ry> | p <pin> | i | s | q
 *                         discover <ms> [extra ip]      wake <ip> <ps5 0|1> <credential>      ping
 *   core -> page (binary): [u8 type][u32 length LE][payload], the same packets as the Windows helper hongsub-rp:
 *                         1 video (H.264), 2 audio header JSON, 3 audio (Opus), 9 JSON event
 * With a web root it also serves those files over http://127.0.0.1:<port>/ (the iPhone app's page).
 */
#ifndef HSRP_H
#define HSRP_H

#ifdef __cplusplus
extern "C" {
#endif

/* Start the core. port 0 = any free port. Returns the port it listens on, or -1. Call once. */
int hsrp_start(int port, const char *token, const char *web_root);

/* Optional: where the core's own log lines go (default: nowhere). */
void hsrp_set_log(void (*fn)(const char *line));

#ifdef __cplusplus
}
#endif

#endif
