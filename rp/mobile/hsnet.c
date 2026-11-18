/* SPDX-License-Identifier: AGPL-3.0-only
 * hsnet: see hsnet.h */
#define _GNU_SOURCE
#include "hsnet.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

static hsnet_emit_fn emitf;
void hsnet_init(hsnet_emit_fn emit) { emitf = emit; }
static void emit(const char *j) { if(emitf) emitf(j); }

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static size_t b64_enc(const uint8_t *p, size_t n, char *o)
{
	size_t k = 0;
	for(size_t i = 0; i < n; i += 3)
	{
		uint32_t v = (uint32_t)p[i] << 16 | (i + 1 < n ? (uint32_t)p[i + 1] << 8 : 0) | (i + 2 < n ? p[i + 2] : 0);
		o[k++] = B64[v >> 18 & 63]; o[k++] = B64[v >> 12 & 63];
		o[k++] = i + 1 < n ? B64[v >> 6 & 63] : '='; o[k++] = i + 2 < n ? B64[v & 63] : '=';
	}
	o[k] = 0; return k;
}
static int b64v(char c) { const char *p = c ? strchr(B64, c) : NULL; return p ? (int)(p - B64) : -1; }
static size_t b64_dec(const char *s, uint8_t *o)
{
	size_t k = 0; uint32_t acc = 0; int bits = 0;
	for(; *s; s++) { int v = b64v(*s); if(v < 0) continue; acc = acc << 6 | (uint32_t)v; bits += 6; if(bits >= 8) { bits -= 8; o[k++] = (uint8_t)(acc >> bits); } }
	return k;
}
static void jesc(char *o, size_t n, const char *s)
{
	size_t k = 0;
	for(; *s && k + 8 < n; s++)
	{
		unsigned char c = (unsigned char)*s;
		if(c == '"' || c == '\\') { o[k++] = '\\'; o[k++] = (char)c; }
		else if(c < 0x20) k += (size_t)snprintf(o + k, n - k, "\\u%04x", c);
		else o[k++] = (char)c;
	}
	o[k] = 0;
}
static bool id_ok(const char *id) { size_t n = 0; for(; id && *id; id++, n++) if(!((*id >= 'a' && *id <= 'z') || (*id >= '0' && *id <= '9'))) return false; return n > 0 && n < 16; }

/* ---------- TCP ---------- */
#define CONNS 4
typedef struct { char id[16]; int fd; pthread_t th; bool used; } Conn;
static Conn conns[CONNS];
static pthread_mutex_t cmx = PTHREAD_MUTEX_INITIALIZER;

typedef struct { char id[16]; char ip[48]; int port; } OpenArg;

static void *reader(void *arg)
{
	OpenArg *a = (OpenArg *)arg;
	char ev[200];
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	struct sockaddr_in to; memset(&to, 0, sizeof(to)); to.sin_family = AF_INET; to.sin_port = htons((uint16_t)a->port);
	bool ok = fd >= 0 && inet_pton(AF_INET, a->ip, &to.sin_addr) == 1;
	const char *why = ok ? "" : "ip";
	if(ok)
	{
#ifdef SO_NOSIGPIPE
		int one = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
		int fl = fcntl(fd, F_GETFL, 0); fcntl(fd, F_SETFL, fl | O_NONBLOCK);
		int c = connect(fd, (struct sockaddr *)&to, sizeof(to));
		if(c != 0 && errno != EINPROGRESS) { ok = false; why = errno == ECONNREFUSED ? "refused" : "connect"; }
		else if(c != 0)
		{
			fd_set wf; FD_ZERO(&wf); FD_SET(fd, &wf); struct timeval tv = { 8, 0 };
			int e = 0; socklen_t el = sizeof(e);
			if(select(fd + 1, NULL, &wf, NULL, &tv) <= 0) { ok = false; why = "timeout"; }
			else if(getsockopt(fd, SOL_SOCKET, SO_ERROR, &e, &el) != 0 || e != 0) { ok = false; why = e == ECONNREFUSED ? "refused" : "connect"; }
		}
		if(ok) { fcntl(fd, F_SETFL, fl); int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)); }
	}
	pthread_mutex_lock(&cmx);
	Conn *me = NULL;
	for(int i = 0; i < CONNS; i++) if(conns[i].used && !strcmp(conns[i].id, a->id)) me = &conns[i];
	if(me && ok) me->fd = fd;
	pthread_mutex_unlock(&cmx);
	if(!me || !ok)
	{
		if(fd >= 0) close(fd);
		pthread_mutex_lock(&cmx); if(me) me->used = false; pthread_mutex_unlock(&cmx);
		snprintf(ev, sizeof(ev), "{\"ev\":\"tcp\",\"id\":\"%s\",\"ok\":false,\"err\":\"%s\"}", a->id, me ? why : "closed");
		emit(ev); free(a); return NULL;
	}
	snprintf(ev, sizeof(ev), "{\"ev\":\"tcp\",\"id\":\"%s\",\"ok\":true}", a->id); emit(ev);
	uint8_t *buf = (uint8_t *)malloc(32768); char *out = (char *)malloc(32768 * 4 / 3 + 128);
	if(buf && out) for(;;)
	{
		ssize_t r = recv(fd, buf, 32768, 0);
		if(r < 0 && errno == EINTR) continue;
		if(r <= 0) break;
		int hn = snprintf(out, 100, "{\"ev\":\"tcpdata\",\"id\":\"%s\",\"b64\":\"", a->id);
		size_t bn = b64_enc(buf, (size_t)r, out + hn);
		memcpy(out + hn + bn, "\"}", 3);
		emit(out);
	}
	free(buf); free(out);
	pthread_mutex_lock(&cmx);
	for(int i = 0; i < CONNS; i++) if(conns[i].used && conns[i].fd == fd) { conns[i].used = false; conns[i].fd = -1; }
	pthread_mutex_unlock(&cmx);
	close(fd);
	snprintf(ev, sizeof(ev), "{\"ev\":\"tcpclose\",\"id\":\"%s\"}", a->id); emit(ev);
	free(a);
	return NULL;
}

void hsnet_tcp_open(const char *id, const char *ip, int port)
{
	char ev[160];
	if(!id_ok(id) || !ip || port <= 0 || port > 65535) { snprintf(ev, sizeof(ev), "{\"ev\":\"tcp\",\"id\":\"%s\",\"ok\":false,\"err\":\"arg\"}", id_ok(id) ? id : "x"); emit(ev); return; }
	pthread_mutex_lock(&cmx);
	Conn *c = NULL;
	for(int i = 0; i < CONNS; i++) if(conns[i].used && !strcmp(conns[i].id, id)) { if(conns[i].fd >= 0) shutdown(conns[i].fd, SHUT_RDWR); conns[i].used = false; }
	for(int i = 0; i < CONNS && !c; i++) if(!conns[i].used) c = &conns[i];
	if(c) { memset(c, 0, sizeof(*c)); snprintf(c->id, sizeof(c->id), "%s", id); c->fd = -1; c->used = true; }
	pthread_mutex_unlock(&cmx);
	if(!c) { snprintf(ev, sizeof(ev), "{\"ev\":\"tcp\",\"id\":\"%s\",\"ok\":false,\"err\":\"busy\"}", id); emit(ev); return; }
	OpenArg *a = (OpenArg *)calloc(1, sizeof(OpenArg));
	if(!a) return;
	snprintf(a->id, sizeof(a->id), "%s", id); snprintf(a->ip, sizeof(a->ip), "%s", ip); a->port = port;
	pthread_t th;
	if(pthread_create(&th, NULL, reader, a) == 0) pthread_detach(th);
	else { free(a); pthread_mutex_lock(&cmx); c->used = false; pthread_mutex_unlock(&cmx); }
}

void hsnet_tcp_send(const char *id, const char *b64)
{
	int fd = -1;
	pthread_mutex_lock(&cmx);
	for(int i = 0; i < CONNS; i++) if(conns[i].used && !strcmp(conns[i].id, id ? id : "")) fd = conns[i].fd;
	pthread_mutex_unlock(&cmx);
	if(fd < 0 || !b64) return;
	size_t n = strlen(b64);
	uint8_t *d = (uint8_t *)malloc(n * 3 / 4 + 4); if(!d) return;
	size_t dn = b64_dec(b64, d), off = 0;
	while(off < dn) { ssize_t r = send(fd, d + off, dn - off, MSG_NOSIGNAL); if(r < 0) { if(errno == EINTR) continue; break; } off += (size_t)r; }
	free(d);
}

void hsnet_tcp_close(const char *id)
{
	pthread_mutex_lock(&cmx);
	for(int i = 0; i < CONNS; i++) if(conns[i].used && !strcmp(conns[i].id, id ? id : "") && conns[i].fd >= 0) shutdown(conns[i].fd, SHUT_RDWR);
	pthread_mutex_unlock(&cmx);
}

/* ---------- catching the sign-in callback ---------- */
static int cfd4 = -1, cfd6 = -1;
static pthread_mutex_t kmx = PTHREAD_MUTEX_INITIALIZER;

static void *catcher(void *arg)
{
	(void)arg;
	for(;;)
	{
		pthread_mutex_lock(&kmx); int a = cfd4, b = cfd6; pthread_mutex_unlock(&kmx);
		if(a < 0 && b < 0) break;
		fd_set rf; FD_ZERO(&rf); int mx = -1;
		if(a >= 0) { FD_SET(a, &rf); mx = a; }
		if(b >= 0) { FD_SET(b, &rf); if(b > mx) mx = b; }
		struct timeval tv = { 1, 0 };
		int s = select(mx + 1, &rf, NULL, NULL, &tv);
		if(s < 0) { if(errno == EINTR) continue; break; }
		if(s == 0) continue;
		int lf = a >= 0 && FD_ISSET(a, &rf) ? a : b;
		int c = accept(lf, NULL, NULL);
		if(c < 0) continue;
		struct timeval rt = { 6, 0 }; setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &rt, sizeof(rt));
		size_t cap = 65536, n = 0; char *req = (char *)malloc(cap + 1);
		if(!req) { close(c); continue; }
		char *body = NULL; long clen = -1;
		while(n < cap)
		{
			ssize_t r = recv(c, req + n, cap - n, 0); if(r <= 0) break; n += (size_t)r; req[n] = 0;
			char *he = strstr(req, "\r\n\r\n");
			if(he && clen < 0) { body = he + 4; char *cl = strcasestr(req, "\ncontent-length:"); clen = cl ? strtol(cl + 16, NULL, 10) : 0; }
			if(body && (long)(n - (size_t)(body - req)) >= clen) break;
		}
		req[n] = 0;
		char method[8] = {0}, path[300] = {0};
		sscanf(req, "%7s %299s", method, path);
		static const char page[] = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><body style='font:18px sans-serif;background:#111;color:#eee;padding:24px'>Đã đăng nhập Samsung. Quay lại Hóng Sub...</body>";
		char h[300]; int hn = snprintf(h, sizeof(h), "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %u\r\nConnection: close\r\n\r\n", (unsigned)(sizeof(page) - 1));
		send(c, h, (size_t)hn, MSG_NOSIGNAL); send(c, page, sizeof(page) - 1, MSG_NOSIGNAL);
		close(c);
		if(!strcmp(method, "POST") && body)
		{
			size_t bl = strlen(body);
			char *eb = (char *)malloc(bl * 6 + 1), *ep = (char *)malloc(sizeof(path) * 6 + 1), *ev = NULL;
			if(eb && ep)
			{
				jesc(eb, bl * 6 + 1, body); jesc(ep, sizeof(path) * 6 + 1, path);
				ev = (char *)malloc(strlen(eb) + strlen(ep) + 64);
				if(ev) { sprintf(ev, "{\"ev\":\"catch\",\"path\":\"%s\",\"body\":\"%s\"}", ep, eb); emit(ev); }
			}
			free(eb); free(ep); free(ev); free(req);
			hsnet_catch_off();
			break;
		}
		free(req);
	}
	return NULL;
}

void hsnet_catch_on(int port)
{
	hsnet_catch_off();
	int one = 1;
	int a = socket(AF_INET, SOCK_STREAM, 0);
	if(a >= 0)
	{
		setsockopt(a, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
		struct sockaddr_in s; memset(&s, 0, sizeof(s)); s.sin_family = AF_INET; s.sin_port = htons((uint16_t)port); s.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		if(bind(a, (struct sockaddr *)&s, sizeof(s)) != 0 || listen(a, 4) != 0) { close(a); a = -1; }
	}
	int b = socket(AF_INET6, SOCK_STREAM, 0);
	if(b >= 0)
	{
		setsockopt(b, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
		setsockopt(b, IPPROTO_IPV6, IPV6_V6ONLY, &one, sizeof(one));
		struct sockaddr_in6 s; memset(&s, 0, sizeof(s)); s.sin6_family = AF_INET6; s.sin6_port = htons((uint16_t)port); s.sin6_addr = in6addr_loopback;
		if(bind(b, (struct sockaddr *)&s, sizeof(s)) != 0 || listen(b, 4) != 0) { close(b); b = -1; }
	}
	char ev[120];
	snprintf(ev, sizeof(ev), "{\"ev\":\"catchon\",\"ok\":%s,\"v4\":%s,\"v6\":%s}", a >= 0 || b >= 0 ? "true" : "false", a >= 0 ? "true" : "false", b >= 0 ? "true" : "false");
	pthread_mutex_lock(&kmx); cfd4 = a; cfd6 = b; pthread_mutex_unlock(&kmx);
	if(a >= 0 || b >= 0) { pthread_t th; if(pthread_create(&th, NULL, catcher, NULL) == 0) pthread_detach(th); }
	emit(ev);
}

void hsnet_catch_off(void)
{
	pthread_mutex_lock(&kmx);
	if(cfd4 >= 0) close(cfd4);
	if(cfd6 >= 0) close(cfd6);
	cfd4 = cfd6 = -1;
	pthread_mutex_unlock(&kmx);
}
