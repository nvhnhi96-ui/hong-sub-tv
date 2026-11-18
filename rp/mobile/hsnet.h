/* SPDX-License-Identifier: AGPL-3.0-only
 * hsnet: plain network pieces the page needs and a web page cannot do itself.
 *  - TCP to a device on the home network (the page speaks the protocol: sdb to a TV Samsung)
 *  - catching the Samsung account sign-in: Samsung's page posts the result to http://localhost:4794/signin/callback */
#ifndef HSNET_H
#define HSNET_H

typedef void (*hsnet_emit_fn)(const char *json);
void hsnet_init(hsnet_emit_fn emit);

/* events: {"ev":"tcp","id":..,"ok":true|false,"err":..}  {"ev":"tcpdata","id":..,"b64":..}  {"ev":"tcpclose","id":..} */
void hsnet_tcp_open(const char *id, const char *ip, int port);
void hsnet_tcp_send(const char *id, const char *b64);
void hsnet_tcp_close(const char *id);

/* event: {"ev":"catch","path":..,"body":..} for the first POST, then it stops listening */
void hsnet_catch_on(int port);
void hsnet_catch_off(void);

#endif
