/* SPDX-License-Identifier: AGPL-3.0-only
 * Hóng Sub phone build of chiaki-lib: no PSN remote connection (holepunch) and no certificate download (aia),
 * which need curl, json-c, miniupnpc and libevent. These stand in for them; the home-network code never
 * reaches them because holepunch_session is always NULL. */
#include <chiaki/common.h>
#include <chiaki/session.h>
#include <chiaki/remote/holepunch.h>
#include <string.h>

ChiakiErrorCode chiaki_aia_init(void) { return CHIAKI_ERR_SUCCESS; }
void chiaki_aia_fini(void) { }

ChiakiHolepunchRegistInfo chiaki_get_regist_info(ChiakiHolepunchSession session)
{ (void)session; ChiakiHolepunchRegistInfo r; memset(&r, 0, sizeof(r)); return r; }
void chiaki_get_ps_selected_addr(ChiakiHolepunchSession session, char *ps_ip) { (void)session; if(ps_ip) ps_ip[0] = 0; }
uint16_t chiaki_get_ps_ctrl_port(ChiakiHolepunchSession session) { (void)session; return 0; }
chiaki_socket_t *chiaki_get_holepunch_sock(ChiakiHolepunchSession session, ChiakiHolepunchPortType type) { (void)session; (void)type; return NULL; }
ChiakiErrorCode holepunch_session_create_offer(ChiakiHolepunchSession session) { (void)session; return CHIAKI_ERR_UNKNOWN; }
ChiakiErrorCode chiaki_holepunch_session_punch_hole(ChiakiHolepunchSession session, ChiakiHolepunchPortType port_type) { (void)session; (void)port_type; return CHIAKI_ERR_UNKNOWN; }
void chiaki_holepunch_session_fini(ChiakiHolepunchSession session) { (void)session; }
