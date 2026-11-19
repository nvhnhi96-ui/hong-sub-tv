/* SPDX-License-Identifier: AGPL-3.0-only
 * hslan: see hslan.h. Same answers as the computer's server in pc/lg.js:
 *   GET /sub?code=K7P2QX&since=N   the newest message plus every message after N (waits up to 15 s for a new one)
 *   GET /alive?code=..&ver=..      the TV app is open
 *   GET /tts?q=..                  the Vietnamese voice: sent on to honggame.store
 *   GET /ping                      who is here
 */
#define _GNU_SOURCE
#include "hslan.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdint.h>
#include <stdbool.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <ctype.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#define BOXES 6
#define ITEMS 12
#define MAXCONN 24

typedef struct { char code[12]; unsigned seq; char *item[ITEMS]; unsigned iseq[ITEMS]; int n; uint64_t seen; char ver[24]; } Box;
static Box boxes[BOXES];
static pthread_mutex_t mx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int lfd = -1, lport = 0, nconn = 0;

static uint64_t ms_now(void) { struct timeval tv; gettimeofday(&tv, NULL); return (uint64_t)tv.tv_sec * 1000 + (uint64_t)tv.tv_usec / 1000; }

static bool code_ok(const char *c, char *out)
{
	size_t n = 0;
	for(; c && *c && n < 9; c++) { if(!isalnum((unsigned char)*c)) return false; out[n++] = (char)toupper((unsigned char)*c); }
	out[n] = 0;
	return n >= 4 && n <= 8 && (!c || !*c);
}

/* the box of a code; a new one takes the place of the one quiet the longest. Called with mx held. */
static Box *box(const char *code, bool make)
{
	Box *old = NULL;
	for(int i = 0; i < BOXES; i++) { if(!strcmp(boxes[i].code, code)) return &boxes[i]; if(!old || boxes[i].seen < old->seen) old = &boxes[i]; }
	if(!make) return NULL;
	for(int i = 0; i < old->n; i++) free(old->item[i]);
	memset(old, 0, sizeof(*old));
	snprintf(old->code, sizeof(old->code), "%s", code);
	old->seen = 0;
	return old;
}

static bool send_all(int fd, const char *p, size_t n)
{
	while(n > 0) { ssize_t r = send(fd, p, n, MSG_NOSIGNAL); if(r < 0) { if(errno == EINTR) continue; return false; } p += r; n -= (size_t)r; }
	return true;
}

static void reply(int fd, const char *status, const char *extra, const char *body)
{
	char h[600]; size_t bl = body ? strlen(body) : 0;
	int hn = snprintf(h, sizeof(h), "HTTP/1.1 %s\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type\r\nCache-Control: no-store\r\n%sContent-Length: %u\r\nConnection: close\r\n\r\n",
		status, extra ? extra : "", (unsigned)bl);
	if(send_all(fd, h, (size_t)hn) && bl) send_all(fd, body, bl);
}

/* value of name= in a query string, as it is (still %-encoded) */
static bool qget(const char *q, const char *name, char *out, size_t n)
{
	size_t nl = strlen(name);
	while(q && *q)
	{
		if(!strncmp(q, name, nl) && q[nl] == '=')
		{
			q += nl + 1; size_t o = 0;
			while(*q && *q != '&' && o + 1 < n) out[o++] = *q++;
			out[o] = 0; return true;
		}
		q = strchr(q, '&'); if(q) q++;
	}
	if(n) out[0] = 0;
	return false;
}

/* newest message + every one after since. Called with mx held. */
static char *answer(Box *b, long since, const char *you)
{
	size_t cap = 256; for(int i = 0; i < b->n; i++) cap += strlen(b->item[i]) * 2 + 4;
	char *o = (char *)malloc(cap); if(!o) return NULL;
	size_t on = 0;
	if(b->n > 0) { const char *last = b->item[b->n - 1]; size_t ll = strlen(last); memcpy(o, last, ll - 1); on = ll - 1; on += (size_t)snprintf(o + on, cap - on, ",\"you\":\"%s\",\"items\":[", you); }
	else on += (size_t)snprintf(o, cap, "{\"seq\":%u,\"you\":\"%s\",\"items\":[", b->seq, you);
	int k = 0;
	if(since >= 0) for(int i = 0; i < b->n; i++) if(b->iseq[i] > (unsigned long)since)
	{
		size_t l = strlen(b->item[i]);
		if(k++) o[on++] = ',';
		memcpy(o + on, b->item[i], l); on += l;
	}
	snprintf(o + on, cap - on, "]}");
	return o;
}

static void *conn(void *arg)
{
	int fd = (int)(intptr_t)arg;
	char req[4096]; size_t n = 0;
	struct timeval tv = { 8, 0 };
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
	while(n + 1 < sizeof(req)) { ssize_t r = recv(fd, req + n, sizeof(req) - 1 - n, 0); if(r <= 0) break; n += (size_t)r; req[n] = 0; if(strstr(req, "\r\n\r\n")) break; }
	req[n] = 0;
	char method[8] = {0}, path[2048] = {0};
	struct sockaddr_in pa; socklen_t pl = sizeof(pa); char you[20] = "";
	if(getpeername(fd, (struct sockaddr *)&pa, &pl) == 0) inet_ntop(AF_INET, &pa.sin_addr, you, sizeof(you));
	if(sscanf(req, "%7s %2047s", method, path) != 2) goto out;
	if(!strcmp(method, "OPTIONS")) { reply(fd, "204 No Content", NULL, NULL); goto out; }
	char *q = strchr(path, '?'); if(q) *q++ = 0;
	if(!strcmp(path, "/ping")) { reply(fd, "200 OK", NULL, "{\"app\":\"hongsub-phone\",\"ok\":true}"); goto out; }
	if(!strcmp(path, "/tts"))
	{
		/* the TV plays the voice it gets from honggame.store, as when there is no home-network link */
		char v[1600]; qget(q, "q", v, sizeof(v));
		char loc[1800]; snprintf(loc, sizeof(loc), "Location: https://honggame.store/wp-json/hgs-sub/v1/tts?q=%s\r\n", v);
		reply(fd, "302 Found", loc, NULL); goto out;
	}
	char raw[16], code[12]; qget(q, "code", raw, sizeof(raw));
	if(!code_ok(raw, code)) { reply(fd, "400 Bad Request", NULL, "{\"ok\":false}"); goto out; }
	char ver[24]; qget(q, "ver", ver, sizeof(ver));
	if(!strcmp(path, "/alive") || !strcmp(path, "/sub"))
	{
		pthread_mutex_lock(&mx);
		Box *b = box(code, true); b->seen = ms_now(); if(ver[0]) snprintf(b->ver, sizeof(b->ver), "%s", ver);
		if(!strcmp(path, "/alive")) { pthread_mutex_unlock(&mx); reply(fd, "200 OK", NULL, "{\"ok\":true}"); goto out; }
		char sb[24]; qget(q, "since", sb, sizeof(sb)); long since = sb[0] ? strtol(sb, NULL, 10) : -1;
		if(since >= 0 && b->seq == (unsigned long)since)
		{
			/* nothing new yet: wait for the next line, up to 15 s */
			struct timeval nw; gettimeofday(&nw, NULL);
			struct timespec until = { nw.tv_sec + 15, (long)nw.tv_usec * 1000 };
			while(b->seq == (unsigned long)since && !strcmp(b->code, code))
				if(pthread_cond_timedwait(&cv, &mx, &until) == ETIMEDOUT) break;
			b = box(code, true); b->seen = ms_now();
		}
		char *a = answer(b, since, you);
		pthread_mutex_unlock(&mx);
		if(a) { reply(fd, "200 OK", NULL, a); free(a); } else reply(fd, "500 Error", NULL, "{\"ok\":false}");
		goto out;
	}
	reply(fd, "404 Not Found", NULL, "{\"ok\":false}");
out:
	close(fd);
	pthread_mutex_lock(&mx); nconn--; pthread_mutex_unlock(&mx);
	return NULL;
}

static void *accepter(void *arg)
{
	int fd = (int)(intptr_t)arg, errs = 0;
	for(;;)
	{
		int c = accept(fd, NULL, NULL);
		if(c < 0)
		{
			if(errno == EINTR || errno == ECONNABORTED) continue;
			/* the phone put the app to sleep and took the socket: start again next time */
			if(++errs > 20) break;
			usleep(200000); continue;
		}
		errs = 0;
#ifdef SO_NOSIGPIPE
		int one = 1; setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
		pthread_mutex_lock(&mx); bool full = nconn >= MAXCONN; if(!full) nconn++; pthread_mutex_unlock(&mx);
		if(full) { close(c); continue; }
		pthread_t th;
		if(pthread_create(&th, NULL, conn, (void *)(intptr_t)c) == 0) pthread_detach(th);
		else { close(c); pthread_mutex_lock(&mx); nconn--; pthread_mutex_unlock(&mx); }
	}
	pthread_mutex_lock(&mx); if(lfd == fd) { lfd = -1; lport = 0; } pthread_mutex_unlock(&mx);
	close(fd);
	return NULL;
}

static bool priv_ip(uint32_t ip) { return (ip >> 24) == 10 || (ip >> 20) == 0xac1 || (ip >> 16) == 0xc0a8; }
/* the address this phone uses to reach `to` (no packet is sent): right even when the list of interfaces is hidden */
static uint32_t route_ip(const char *to)
{
	struct sockaddr_in a; memset(&a, 0, sizeof(a)); a.sin_family = AF_INET; a.sin_port = htons(9);
	if(!to || inet_pton(AF_INET, to, &a.sin_addr) != 1) return 0;
	int u = socket(AF_INET, SOCK_DGRAM, 0); if(u < 0) return 0;
	uint32_t r = 0;
	if(connect(u, (struct sockaddr *)&a, sizeof(a)) == 0) { struct sockaddr_in me; socklen_t ml = sizeof(me); if(getsockname(u, (struct sockaddr *)&me, &ml) == 0) r = ntohl(me.sin_addr.s_addr); }
	close(u);
	return r;
}
/* this phone's addresses on home networks, the right one first, comma separated.
   The first one is what the TV is told (and what a person types on a TV Samsung in Developer Mode), so it must be the
   phone's Wi-Fi address on the TV's network: never the mobile-data address (Android rmnet/ccmni, iPhone pdp_ip, which
   are often 10.x too) nor a VPN's (tun, utun, ipsec). Order: the interface on the TV's own network, then Wi-Fi,
   then other home-looking interfaces. */
static int if_kind(const char *n)
{
	if(!n) return 2;
	static const char *cell[] = { "rmnet", "ccmni", "pdp_ip", "v4-", "clat", "tun", "utun", "ppp", "ipsec", "dummy", "rev_rmnet", "seth", "wwan", "usb", "rndis", "bridge", "llw", "awdl", "anpi", "gif", "stf", "p2p" };
	for(size_t k = 0; k < sizeof(cell) / sizeof(cell[0]); k++) if(!strncmp(n, cell[k], strlen(cell[k]))) return 3;   /* not the home network */
	if(!strncmp(n, "wlan", 4) || !strncmp(n, "swlan", 5) || !strncmp(n, "en", 2) || !strncmp(n, "eth", 3) || !strncmp(n, "ap", 2) || !strncmp(n, "wl", 2) || !strncmp(n, "mlan", 4)) return 1;   /* Wi-Fi / wired */
	return 2;
}
static void add_ip(char *out, size_t n, size_t *on, uint32_t ip)
{
	char a[20]; struct in_addr ia; ia.s_addr = htonl(ip); inet_ntop(AF_INET, &ia, a, sizeof(a));
	char key[24]; snprintf(key, sizeof(key), "%s,", a);
	char tmp[256]; snprintf(tmp, sizeof(tmp), "%s,", out);
	if(strstr(tmp, key)) return;
	if(*on + strlen(a) + 2 < n) *on += (size_t)snprintf(out + *on, n - *on, "%s%s", *on ? "," : "", a);
}
static void my_ips(const char *hint, char *out, size_t n)
{
	struct ifaddrs *ifs = NULL; size_t on = 0; out[0] = 0;
	uint32_t hip = 0; { struct in_addr a; if(hint && inet_pton(AF_INET, hint, &a) == 1) hip = ntohl(a.s_addr); }
	struct { uint32_t ip, mask; int kind; } L[16]; int nl = 0;
	if(getifaddrs(&ifs) == 0)
	{
		for(struct ifaddrs *i = ifs; i && nl < 16; i = i->ifa_next)
		{
			if(!i->ifa_addr || i->ifa_addr->sa_family != AF_INET || (i->ifa_flags & IFF_LOOPBACK) || !(i->ifa_flags & IFF_UP)) continue;
			uint32_t ip = ntohl(((struct sockaddr_in *)i->ifa_addr)->sin_addr.s_addr);
			if(!priv_ip(ip)) continue;
			L[nl].ip = ip; L[nl].mask = i->ifa_netmask ? ntohl(((struct sockaddr_in *)i->ifa_netmask)->sin_addr.s_addr) : 0xffffff00u; L[nl].kind = if_kind(i->ifa_name); nl++;
		}
		freeifaddrs(ifs);
	}
	/* 1. on the TV's own network */
	if(hip) for(int k = 0; k < nl; k++) { uint32_t m = L[k].mask ? L[k].mask : 0xffffff00u; if(L[k].kind != 3 && (L[k].ip & m) == (hip & m)) add_ip(out, n, &on, L[k].ip); }
	if(hip) { uint32_t r = route_ip(hint); int k2 = -1; for(int k = 0; k < nl; k++) if(L[k].ip == r) k2 = k; if(r && priv_ip(r) && (k2 < 0 ? nl == 0 : L[k2].kind != 3)) add_ip(out, n, &on, r); }
	/* 2. Wi-Fi / wired, 3. other home-looking interfaces */
	for(int pass = 1; pass <= 2; pass++) for(int k = 0; k < nl; k++) if(L[k].kind == pass) add_ip(out, n, &on, L[k].ip);
	/* the list of interfaces is hidden (some phones): the address used towards the home router or the internet */
	if(!on)
	{
		const char *tries[] = { "192.168.1.1", "192.168.0.1", "8.8.8.8" };
		for(int k = 0; k < 3; k++) { uint32_t ip = route_ip(tries[k]); if(ip && priv_ip(ip)) add_ip(out, n, &on, ip); }
	}
}

int hslan_on(const char *hint, char *ips, size_t ips_size)
{
	if(ips && ips_size) my_ips(hint, ips, ips_size);
	pthread_mutex_lock(&mx);
	if(lfd >= 0) { int p = lport; pthread_mutex_unlock(&mx); return p; }
	pthread_mutex_unlock(&mx);
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if(fd < 0) return 0;
	int one = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	int port = 0;
	for(int p = HSLAN_PORT; p < HSLAN_PORT + 4 && !port; p++)
	{
		struct sockaddr_in a; memset(&a, 0, sizeof(a)); a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons((uint16_t)p);
		if(bind(fd, (struct sockaddr *)&a, sizeof(a)) == 0) port = p;
	}
	if(!port || listen(fd, 16) != 0) { close(fd); return 0; }
	pthread_mutex_lock(&mx); lfd = fd; lport = port; pthread_mutex_unlock(&mx);
	pthread_t th;
	if(pthread_create(&th, NULL, accepter, (void *)(intptr_t)fd) != 0) { pthread_mutex_lock(&mx); lfd = -1; lport = 0; pthread_mutex_unlock(&mx); close(fd); return 0; }
	pthread_detach(th);
	return port;
}

void hslan_push(const char *rawcode, const char *json)
{
	char code[12];
	if(!code_ok(rawcode, code) || !json) return;
	while(*json == ' ' || *json == '\n' || *json == '\r') json++;
	size_t jl = strlen(json);
	while(jl && (json[jl - 1] == ' ' || json[jl - 1] == '\n' || json[jl - 1] == '\r')) jl--;
	if(jl < 2 || json[0] != '{' || json[jl - 1] != '}') return;
	pthread_mutex_lock(&mx);
	Box *b = box(code, true);
	b->seq++;
	char *it = (char *)malloc(jl + 32);
	if(it)
	{
		bool empty = true; for(size_t i = 1; i + 1 < jl; i++) if(json[i] != ' ') { empty = false; break; }
		int hn = snprintf(it, jl + 32, "{\"seq\":%u%s", b->seq, empty ? "" : ",");
		memcpy(it + hn, json + 1, jl - 1); it[hn + jl - 1] = 0;
		if(b->n == ITEMS) { free(b->item[0]); memmove(b->item, b->item + 1, sizeof(char *) * (ITEMS - 1)); memmove(b->iseq, b->iseq + 1, sizeof(unsigned) * (ITEMS - 1)); b->n--; }
		b->item[b->n] = it; b->iseq[b->n] = b->seq; b->n++;
	}
	pthread_cond_broadcast(&cv);
	pthread_mutex_unlock(&mx);
}

long long hslan_seen(const char *rawcode, char *ver, size_t vn)
{
	char code[12]; long long r = -1;
	if(ver && vn) ver[0] = 0;
	if(!code_ok(rawcode, code)) return -1;
	pthread_mutex_lock(&mx);
	Box *b = box(code, false);
	if(b && b->seen) { r = (long long)(ms_now() - b->seen); if(ver && vn) snprintf(ver, vn, "%s", b->ver); }
	pthread_mutex_unlock(&mx);
	return r;
}

void hslan_codes(char *out, size_t n)
{
	size_t on = 0; out[0] = 0; uint64_t t = ms_now();
	pthread_mutex_lock(&mx);
	for(int i = 0; i < BOXES; i++) if(boxes[i].code[0] && boxes[i].seen && t - boxes[i].seen < 30000 && on + 12 < n)
		on += (size_t)snprintf(out + on, n - on, "%s%s", on ? "," : "", boxes[i].code);
	pthread_mutex_unlock(&mx);
}

/* ---------- finding TVs LG and Samsung ----------
   SSDP: asked on the multicast address (Android) and of every address of the phone's network one by one (the iPhone
   may not send multicast without an Apple permission). Plus the ports these TVs keep open:
   LG 3000/3001 (second screen), 9922 (Developer Mode); Samsung 8001/8002 (remote control). */
static void jstr(char *o, size_t n, const char *s)
{
	size_t k = 0;
	for(; *s && k + 7 < n; s++)
	{
		unsigned char c = (unsigned char)*s;
		if(c == '"' || c == '\\') { o[k++] = '\\'; o[k++] = (char)c; }
		else if(c == '\n') { o[k++] = '\\'; o[k++] = 'n'; }
		else if(c < 0x20) o[k++] = ' ';
		else o[k++] = (char)c;
	}
	o[k] = 0;
}

typedef struct { uint32_t ip; char ports[40]; char text[1200]; } Hit;

static Hit *hit_for(Hit *h, int *nh, int cap, uint32_t ip)
{
	for(int i = 0; i < *nh; i++) if(h[i].ip == ip) return &h[i];
	if(*nh >= cap) return NULL;
	memset(&h[*nh], 0, sizeof(Hit)); h[*nh].ip = ip; return &h[(*nh)++];
}

void hslan_find(int ms, char *out, size_t cap)
{
	if(ms < 800 || ms > 8000) ms = 3000;
	uint32_t self[8], hosts[1100]; int ns = 0, nh = 0;
	struct ifaddrs *ifs = NULL;
	if(getifaddrs(&ifs) == 0)
	{
		for(struct ifaddrs *i = ifs; i; i = i->ifa_next)
		{
			if(!i->ifa_addr || i->ifa_addr->sa_family != AF_INET || !i->ifa_netmask || (i->ifa_flags & IFF_LOOPBACK)) continue;
			uint32_t ip = ntohl(((struct sockaddr_in *)i->ifa_addr)->sin_addr.s_addr), mask = ntohl(((struct sockaddr_in *)i->ifa_netmask)->sin_addr.s_addr);
			if((ip >> 24) == 169 || (ip >> 24) == 127 || ns >= 8) continue;
			self[ns++] = ip;
			if(mask < 0xfffffc00u) mask = 0xffffff00u;   /* a big network: the phone's own /24 */
			uint32_t net = ip & mask, cnt = ~mask;
			for(uint32_t k = 1; k < cnt && nh < 1100; k++) { uint32_t a = net | k; if(a != ip) hosts[nh++] = a; }
		}
		freeifaddrs(ifs);
	}
	Hit *hit = (Hit *)calloc(48, sizeof(Hit)); int nhit = 0;
	if(!hit) { snprintf(out, cap, "{\"ev\":\"lanfind\",\"list\":[]}"); return; }
	uint64_t t0 = ms_now(), end = t0 + (uint64_t)ms;

	/* SSDP */
	int u = socket(AF_INET, SOCK_DGRAM, 0);
	if(u >= 0)
	{
		struct sockaddr_in me; memset(&me, 0, sizeof(me)); me.sin_family = AF_INET; me.sin_addr.s_addr = htonl(INADDR_ANY);
		bind(u, (struct sockaddr *)&me, sizeof(me));
		int fl = fcntl(u, F_GETFL, 0); fcntl(u, F_SETFL, fl | O_NONBLOCK);
		static const char *st[] = { "urn:lge-com:service:webos-second-screen:1", "urn:samsung.com:device:RemoteControlReceiver:1", "urn:dial-multiscreen-org:service:dial:1" };
		for(int s = 0; s < 3; s++)
		{
			char m[300]; int ml = snprintf(m, sizeof(m), "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: %s\r\n\r\n", st[s]);
			struct sockaddr_in to; memset(&to, 0, sizeof(to)); to.sin_family = AF_INET; to.sin_port = htons(1900);
			to.sin_addr.s_addr = inet_addr("239.255.255.250"); sendto(u, m, (size_t)ml, 0, (struct sockaddr *)&to, sizeof(to));
			if(s == 0 || s == 1) for(int k = 0; k < nh; k++) { to.sin_addr.s_addr = htonl(hosts[k]); sendto(u, m, (size_t)ml, 0, (struct sockaddr *)&to, sizeof(to)); }
		}
	}

	/* the ports, a batch of addresses at a time (the iPhone allows few open sockets) */
	static const int ports[] = { 3000, 3001, 9922, 8001, 8002 };
	const int NP = 5, BATCH = 24;
	int at = 0;
	while(at < nh && ms_now() < end)
	{
		int fds[24 * 5], nf = 0; uint32_t fip[24 * 5]; int fpt[24 * 5];
		for(int k = at; k < nh && k < at + BATCH; k++)
			for(int p = 0; p < NP; p++)
			{
				int s = socket(AF_INET, SOCK_STREAM, 0); if(s < 0) continue;
				fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) | O_NONBLOCK);
#ifdef SO_NOSIGPIPE
				int one = 1; setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
				struct sockaddr_in to; memset(&to, 0, sizeof(to)); to.sin_family = AF_INET; to.sin_port = htons((uint16_t)ports[p]); to.sin_addr.s_addr = htonl(hosts[k]);
				int c = connect(s, (struct sockaddr *)&to, sizeof(to));
				if(c != 0 && errno != EINPROGRESS) { close(s); continue; }
				fds[nf] = s; fip[nf] = hosts[k]; fpt[nf] = ports[p]; nf++;
			}
		at += BATCH;
		uint64_t until = ms_now() + 300; if(until > end) until = end;
		while(nf > 0 && ms_now() < until)
		{
			fd_set wf; FD_ZERO(&wf); int mxfd = -1;
			for(int i = 0; i < nf; i++) if(fds[i] >= 0 && fds[i] < FD_SETSIZE) { FD_SET(fds[i], &wf); if(fds[i] > mxfd) mxfd = fds[i]; }
			if(mxfd < 0) break;
			struct timeval tv = { 0, 60000 };
			if(select(mxfd + 1, NULL, &wf, NULL, &tv) <= 0) continue;
			for(int i = 0; i < nf; i++) if(fds[i] >= 0 && FD_ISSET(fds[i], &wf))
			{
				int e = 0; socklen_t el = sizeof(e); getsockopt(fds[i], SOL_SOCKET, SO_ERROR, &e, &el);
				if(e == 0) { Hit *h = hit_for(hit, &nhit, 48, fip[i]); if(h) { size_t l = strlen(h->ports); snprintf(h->ports + l, sizeof(h->ports) - l, "%s%d", l ? "," : "", fpt[i]); } }
				close(fds[i]); fds[i] = -1;
			}
		}
		for(int i = 0; i < nf; i++) if(fds[i] >= 0) close(fds[i]);
		/* SSDP answers that came in meanwhile */
		if(u >= 0) for(;;)
		{
			char rb[1400]; struct sockaddr_in from; socklen_t fl2 = sizeof(from);
			ssize_t r = recvfrom(u, rb, sizeof(rb) - 1, 0, (struct sockaddr *)&from, &fl2);
			if(r <= 0) break;
			rb[r] = 0;
			if(!strcasestr(rb, "lge") && !strcasestr(rb, "webos") && !strcasestr(rb, "samsung") && !strcasestr(rb, "tizen")) continue;
			Hit *h = hit_for(hit, &nhit, 48, ntohl(from.sin_addr.s_addr));
			if(h && strlen(h->text) + (size_t)r + 4 < sizeof(h->text)) { strcat(h->text, rb); strcat(h->text, "\n"); }
		}
	}
	/* the last SSDP answers */
	while(u >= 0 && ms_now() < end)
	{
		fd_set rf; FD_ZERO(&rf); FD_SET(u, &rf); struct timeval tv = { 0, 100000 };
		if(select(u + 1, &rf, NULL, NULL, &tv) <= 0) { if(ms_now() > t0 + 1500 && nhit) break; continue; }
		char rb[1400]; struct sockaddr_in from; socklen_t fl2 = sizeof(from);
		ssize_t r = recvfrom(u, rb, sizeof(rb) - 1, 0, (struct sockaddr *)&from, &fl2);
		if(r <= 0) continue;
		rb[r] = 0;
		if(!strcasestr(rb, "lge") && !strcasestr(rb, "webos") && !strcasestr(rb, "samsung") && !strcasestr(rb, "tizen")) continue;
		Hit *h = hit_for(hit, &nhit, 48, ntohl(from.sin_addr.s_addr));
		if(h && strlen(h->text) + (size_t)r + 4 < sizeof(h->text)) { strcat(h->text, rb); strcat(h->text, "\n"); }
	}
	if(u >= 0) close(u);
	size_t on = (size_t)snprintf(out, cap, "{\"ev\":\"lanfind\",\"list\":["); int k = 0;
	for(int i = 0; i < nhit; i++)
	{
		bool mine = false; for(int s = 0; s < ns; s++) if(self[s] == hit[i].ip) mine = true;
		if(mine) continue;
		char a[20]; struct in_addr ia; ia.s_addr = htonl(hit[i].ip); inet_ntop(AF_INET, &ia, a, sizeof(a));
		char esc[2600]; jstr(esc, sizeof(esc), hit[i].text);
		if(on + strlen(esc) + 120 < cap) on += (size_t)snprintf(out + on, cap - on, "%s{\"addr\":\"%s\",\"ports\":[%s],\"text\":\"%s\"}", k++ ? "," : "", a, hit[i].ports, esc);
	}
	snprintf(out + on, cap - on, "]}");
	free(hit);
}
