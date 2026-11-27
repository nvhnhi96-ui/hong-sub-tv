/* SPDX-License-Identifier: AGPL-3.0-only
 * hsrp: Remote Play core of the Hóng Sub phone apps (see hsrp.h), built on chiaki-ng's chiaki-lib (AGPL-3.0).
 * Source: https://github.com/nvhnhi96-ui/hong-sub-tv/tree/main/rp/mobile
 */
#include "hsrp.h"
#include "hslan.h"
#include "hsnet.h"

#include <chiaki/common.h>
#include <chiaki/log.h>
#include <chiaki/session.h>
#include <chiaki/regist.h>
#include <chiaki/base64.h>
#include <chiaki/controller.h>

#include <mbedtls/sha1.h>

#include <pthread.h>
#include <stdio.h>
#include <stdarg.h>
#include <strings.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

static void (*log_fn)(const char *) = NULL;
static char g_token[80];
static char g_root[1024];
static int g_listen = -1;

void hsrp_set_log(void (*fn)(const char *line)) { log_fn = fn; }

static void hlog(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static int split(char *s, char **av, int max);
static uint64_t now_ms(void);
static void hlog(const char *fmt, ...)
{
	if(!log_fn) return;
	char b[600];
	va_list ap; va_start(ap, fmt); vsnprintf(b, sizeof(b), fmt, ap); va_end(ap);
	log_fn(b);
}

static void sleep_ms(int ms) { usleep((useconds_t)ms * 1000); }

static void json_str(char *out, size_t out_size, const char *s)
{
	size_t o = 0;
	if(!s) s = "";
	for(; *s && o + 7 < out_size; s++)
	{
		unsigned char c = (unsigned char)*s;
		if(c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = (char)c; }
		else if(c == '\n') { out[o++] = '\\'; out[o++] = 'n'; }
		else if(c == '\r' || c == '\t') out[o++] = ' ';
		else if(c < 0x20) o += (size_t)snprintf(out + o, out_size - o, "\\u%04x", c);
		else out[o++] = (char)c;
	}
	out[o] = 0;
}

/* ================= sending to the page: one queue, one writer thread ================= */

typedef struct Item { struct Item *next; size_t len; uint8_t type; uint8_t data[]; } Item;

static pthread_mutex_t q_mx = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t w_mx = PTHREAD_MUTEX_INITIALIZER;   /* one frame at a time on the socket */
static pthread_cond_t q_cv = PTHREAD_COND_INITIALIZER;
static Item *q_head = NULL, *q_tail = NULL;
static size_t q_bytes = 0;
static int ws_fd = -1;           /* the page's WebSocket (newest page wins) */
static unsigned ws_gen = 0;      /* changes whenever ws_fd changes */
static bool drop_video = false;  /* the page fell behind: skip pictures until the next key frame */
static void request_idr_soon(void);

static bool h264_has_key(const uint8_t *d, size_t n)
{
	for(size_t i = 0; i + 4 < n; i++)
	{
		if(d[i] == 0 && d[i + 1] == 0 && (d[i + 2] == 1 || (d[i + 2] == 0 && d[i + 3] == 1)))
		{
			size_t j = d[i + 2] == 1 ? i + 3 : i + 4;
			if(j >= n) break;
			int t = d[j] & 31;
			if(t == 5 || t == 7) return true;
			i = j;
		}
	}
	return false;
}

/* a packet for the page: [type][u32 len][a][b] in one WebSocket message */
static void emit(uint8_t type, const uint8_t *a, size_t a_len, const uint8_t *b, size_t b_len)
{
	size_t len = 5 + a_len + b_len;
	pthread_mutex_lock(&q_mx);
	if(ws_fd < 0) { pthread_mutex_unlock(&q_mx); return; }
	if(type == 1)
	{
		const uint8_t *pic = b_len ? b : a; size_t pic_n = b_len ? b_len : a_len;
		if(drop_video)
		{
			if(!h264_has_key(pic, pic_n)) { pthread_mutex_unlock(&q_mx); return; }
			drop_video = false;
		}
		else if(q_bytes > 3 * 1024 * 1024)
		{
			drop_video = true;
			pthread_mutex_unlock(&q_mx);
			request_idr_soon();
			return;
		}
	}
	Item *it = (Item *)malloc(sizeof(Item) + len);
	if(!it) { pthread_mutex_unlock(&q_mx); return; }
	it->next = NULL; it->len = len; it->type = type;
	it->data[0] = type;
	uint32_t l = (uint32_t)(a_len + b_len);
	it->data[1] = l & 0xff; it->data[2] = (l >> 8) & 0xff; it->data[3] = (l >> 16) & 0xff; it->data[4] = (l >> 24) & 0xff;
	if(a_len) memcpy(it->data + 5, a, a_len);
	if(b_len) memcpy(it->data + 5 + a_len, b, b_len);
	if(q_tail) q_tail->next = it; else q_head = it;
	q_tail = it; q_bytes += len;
	pthread_cond_signal(&q_cv);
	pthread_mutex_unlock(&q_mx);
}

static void emit_event(const char *json) { emit(9, (const uint8_t *)json, strlen(json), NULL, 0); }

static bool send_all(int fd, const uint8_t *p, size_t n)
{
	while(n > 0)
	{
		ssize_t r = send(fd, p, n, MSG_NOSIGNAL);
		if(r < 0) { if(errno == EINTR) continue; return false; }
		p += r; n -= (size_t)r;
	}
	return true;
}

static bool ws_send_frame(int fd, int opcode, const uint8_t *p, size_t n)
{
	uint8_t h[10]; size_t hl;
	h[0] = (uint8_t)(0x80 | opcode);
	if(n < 126) { h[1] = (uint8_t)n; hl = 2; }
	else if(n < 65536) { h[1] = 126; h[2] = (uint8_t)(n >> 8); h[3] = (uint8_t)n; hl = 4; }
	else { h[1] = 127; for(int i = 0; i < 8; i++) h[2 + i] = (uint8_t)((uint64_t)n >> (56 - 8 * i)); hl = 10; }
	return send_all(fd, h, hl) && send_all(fd, p, n);
}

static void *writer_thread(void *arg)
{
	(void)arg;
	for(;;)
	{
		pthread_mutex_lock(&q_mx);
		while(!q_head) pthread_cond_wait(&q_cv, &q_mx);
		Item *it = q_head; q_head = it->next; if(!q_head) q_tail = NULL;
		q_bytes -= it->len;
		int fd = ws_fd; unsigned gen = ws_gen;
		pthread_mutex_unlock(&q_mx);
		bool ok = true;
		if(fd >= 0) { pthread_mutex_lock(&w_mx); ok = ws_send_frame(fd, 2, it->data, it->len); pthread_mutex_unlock(&w_mx); }
		if(!ok)
		{
			pthread_mutex_lock(&q_mx);
			if(ws_gen == gen && ws_fd == fd) { shutdown(fd, SHUT_RDWR); }
			pthread_mutex_unlock(&q_mx);
		}
		free(it);
	}
	return NULL;
}

static void queue_clear_locked(void)
{
	while(q_head) { Item *n = q_head->next; free(q_head); q_head = n; }
	q_tail = NULL; q_bytes = 0; drop_video = false;
}

/* ================= chiaki log ================= */

static void log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	char esc[1000], buf[1100];
	json_str(esc, sizeof(esc), msg);
	snprintf(buf, sizeof(buf), "{\"ev\":\"log\",\"level\":%d,\"msg\":\"%s\"}", (int)level, esc);
	emit_event(buf);
	hlog("[%d] %s", (int)level, msg);
}

static bool b64_decode_exact(const char *in, uint8_t *out, size_t want)
{
	uint8_t tmp[256];
	size_t n = sizeof(tmp);
	if(!in || chiaki_base64_decode(in, strlen(in), tmp, &n) != CHIAKI_ERR_SUCCESS) return false;
	if(n < want) return false;
	memcpy(out, tmp, want);
	return true;
}

/* ================= pairing ================= */

typedef struct { char host[64]; int ps5; char account[64]; char pin[16]; } RegistJob;
static pthread_mutex_t reg_mx = PTHREAD_MUTEX_INITIALIZER;
static bool reg_busy = false;
static volatile int regist_done = 0;
static char regist_result[1024];

static void regist_cb(ChiakiRegistEvent *event, void *user)
{
	(void)user;
	if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && event->registered_host)
	{
		ChiakiRegisteredHost *h = event->registered_host;
		char key_b64[64] = {0}, morning_b64[64] = {0}, nick[96] = {0};
		chiaki_base64_encode((const uint8_t *)h->rp_regist_key, sizeof(h->rp_regist_key), key_b64, sizeof(key_b64));
		chiaki_base64_encode(h->rp_key, sizeof(h->rp_key), morning_b64, sizeof(morning_b64));
		char nick_raw[sizeof(h->server_nickname) + 1] = {0};
		memcpy(nick_raw, h->server_nickname, sizeof(h->server_nickname));
		json_str(nick, sizeof(nick), nick_raw);
		snprintf(regist_result, sizeof(regist_result),
			"{\"ev\":\"regist\",\"ok\":true,\"regist_key\":\"%s\",\"morning\":\"%s\",\"nickname\":\"%s\",\"mac\":\"%02x%02x%02x%02x%02x%02x\",\"target\":%d}",
			key_b64, morning_b64, nick,
			h->server_mac[0], h->server_mac[1], h->server_mac[2], h->server_mac[3], h->server_mac[4], h->server_mac[5], (int)h->target);
	}
	else if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_CANCELED)
		snprintf(regist_result, sizeof(regist_result), "{\"ev\":\"regist\",\"ok\":false,\"err\":\"canceled\"}");
	else
		snprintf(regist_result, sizeof(regist_result), "{\"ev\":\"regist\",\"ok\":false,\"err\":\"failed\"}");
	regist_done = 1;
}

static void *regist_thread(void *arg)
{
	RegistJob *job = (RegistJob *)arg;
	ChiakiLog log;
	chiaki_log_init(&log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO, log_cb, NULL);
	ChiakiRegistInfo info;
	memset(&info, 0, sizeof(info));
	info.target = job->ps5 ? CHIAKI_TARGET_PS5_1 : CHIAKI_TARGET_PS4_10;
	info.host = job->host;
	info.broadcast = false;
	info.psn_online_id = NULL;
	info.pin = (uint32_t)strtoul(job->pin, NULL, 10);
	info.console_pin = 0;
	info.holepunch_info = NULL;
	regist_done = 0;
	if(!b64_decode_exact(job->account, info.psn_account_id, CHIAKI_PSN_ACCOUNT_ID_SIZE))
		snprintf(regist_result, sizeof(regist_result), "{\"ev\":\"regist\",\"ok\":false,\"err\":\"account\"}");
	else
	{
		/* first as chiaki does it (a UDP socket "connected" to the console). On iPhones that socket was sometimes refused
		   at once ("Regist failed to send search: Broken pipe", 11/2026) while finding the console (plain sendto) worked:
		   a failure that quick is tried again the way finding does it, an unconnected socket sending to the console */
		for(int attempt = 0; attempt < 2; attempt++)
		{
			ChiakiRegist regist;
			regist_done = 0;
			uint64_t t0 = now_ms();
			ChiakiErrorCode err = chiaki_regist_start(&regist, &log, &info, regist_cb, NULL);
			if(err != CHIAKI_ERR_SUCCESS)
			{
				snprintf(regist_result, sizeof(regist_result), "{\"ev\":\"regist\",\"ok\":false,\"err\":\"%s\"}", chiaki_error_string(err));
				break;
			}
			for(int i = 0; i < 300 && !regist_done; i++) sleep_ms(100);
			if(!regist_done)
			{
				chiaki_regist_stop(&regist);
				snprintf(regist_result, sizeof(regist_result), "{\"ev\":\"regist\",\"ok\":false,\"err\":\"timeout\"}");
			}
			chiaki_regist_fini(&regist);
			bool quick_fail = regist_done && strstr(regist_result, "\"err\":\"failed\"") && now_ms() - t0 < 1500;
			if(!quick_fail || info.broadcast) break;
			{ char m[] = "Regist: trying again with an unconnected socket"; log_cb(CHIAKI_LOG_INFO, m, NULL); }
			info.broadcast = true;
		}
	}
	emit_event(regist_result);
	free(job);
	pthread_mutex_lock(&reg_mx); reg_busy = false; pthread_mutex_unlock(&reg_mx);
	return NULL;
}

/* ================= stream ================= */

typedef struct {
	ChiakiSession session;
	ChiakiLog log;
	pthread_mutex_t mx;
	pthread_cond_t cv;
	bool stop, sleep, quit, started;
	pthread_t th;
} Stream;

static pthread_mutex_t st_mx = PTHREAD_MUTEX_INITIALIZER;
static Stream *cur = NULL;       /* the running session (its own thread ends it) */
static uint64_t last_idr = 0;

static uint64_t now_ms(void) { struct timeval tv; gettimeofday(&tv, NULL); return (uint64_t)tv.tv_sec * 1000 + (uint64_t)tv.tv_usec / 1000; }

static void request_idr_soon(void)
{
	pthread_mutex_lock(&st_mx);
	uint64_t n = now_ms();
	if(cur && cur->started && n - last_idr > 500) { last_idr = n; chiaki_session_request_idr(&cur->session); }
	pthread_mutex_unlock(&st_mx);
}

static bool video_cb(uint8_t *buf, size_t buf_size, int32_t frames_lost, bool frame_recovered, void *user)
{
	(void)user;
	uint8_t pre[5];
	pre[0] = frame_recovered ? 1 : 0;
	uint32_t fl = (uint32_t)frames_lost;
	pre[1] = fl & 0xff; pre[2] = (fl >> 8) & 0xff; pre[3] = (fl >> 16) & 0xff; pre[4] = (fl >> 24) & 0xff;
	emit(1, pre, 5, buf, buf_size);
	return true;
}

static void audio_header_cb(ChiakiAudioHeader *header, void *user)
{
	(void)user;
	char buf[160];
	snprintf(buf, sizeof(buf), "{\"channels\":%u,\"bits\":%u,\"rate\":%u,\"frame_size\":%u}",
		(unsigned)header->channels, (unsigned)header->bits, (unsigned)header->rate, (unsigned)header->frame_size);
	emit(2, (const uint8_t *)buf, strlen(buf), NULL, 0);
}

static void audio_frame_cb(uint8_t *buf, size_t buf_size, void *user) { (void)user; emit(3, buf, buf_size, NULL, 0); }

static void event_cb(ChiakiEvent *event, void *user)
{
	Stream *s = (Stream *)user;
	char buf[512], esc[256];
	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED: emit_event("{\"ev\":\"connected\"}"); break;
		case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
			snprintf(buf, sizeof(buf), "{\"ev\":\"pin\",\"incorrect\":%s}", event->login_pin_request.pin_incorrect ? "true" : "false");
			emit_event(buf);
			break;
		case CHIAKI_EVENT_NICKNAME_RECEIVED:
			json_str(esc, sizeof(esc), event->server_nickname);
			snprintf(buf, sizeof(buf), "{\"ev\":\"nickname\",\"name\":\"%s\"}", esc);
			emit_event(buf);
			break;
		case CHIAKI_EVENT_QUIT:
			json_str(esc, sizeof(esc), event->quit.reason_str ? event->quit.reason_str : "");
			snprintf(buf, sizeof(buf), "{\"ev\":\"quit\",\"reason\":%d,\"text\":\"%s\",\"str\":\"%s\"}",
				(int)event->quit.reason, chiaki_quit_reason_string(event->quit.reason), esc);
			emit_event(buf);
			pthread_mutex_lock(&s->mx); s->quit = true; pthread_cond_signal(&s->cv); pthread_mutex_unlock(&s->mx);
			break;
		case CHIAKI_EVENT_RUMBLE:
			snprintf(buf, sizeof(buf), "{\"ev\":\"rumble\",\"l\":%u,\"r\":%u}", (unsigned)event->rumble.left, (unsigned)event->rumble.right);
			emit_event(buf);
			break;
		default: break;
	}
}

/* each session has one thread: it waits for "stop" (or the console quitting), then ends the session */
static void *stream_thread(void *arg)
{
	Stream *s = (Stream *)arg;
	pthread_mutex_lock(&s->mx);
	while(!s->stop && !s->quit) pthread_cond_wait(&s->cv, &s->mx);
	bool sleep_after = s->sleep && !s->quit;
	pthread_mutex_unlock(&s->mx);
	if(sleep_after) { chiaki_session_goto_bed(&s->session); sleep_ms(300); }
	pthread_mutex_lock(&st_mx); if(cur == s) cur = NULL; s->started = false; pthread_mutex_unlock(&st_mx);
	chiaki_session_stop(&s->session);
	chiaki_session_join(&s->session);
	chiaki_session_fini(&s->session);
	emit_event("{\"ev\":\"closed\"}");
	pthread_mutex_destroy(&s->mx);
	pthread_cond_destroy(&s->cv);
	free(s);
	return NULL;
}

static void stream_stop(bool sleep)
{
	pthread_mutex_lock(&st_mx);
	Stream *s = cur; cur = NULL;
	pthread_mutex_unlock(&st_mx);
	if(!s) return;
	pthread_mutex_lock(&s->mx); s->stop = true; s->sleep = sleep; pthread_cond_signal(&s->cv); pthread_mutex_unlock(&s->mx);
}

static void stream_start(char **av, int ac)
{
	char buf[256];
	if(ac < 7) { emit_event("{\"ev\":\"quit\",\"reason\":-1,\"text\":\"usage\",\"str\":\"\"}"); return; }
	stream_stop(false);
	Stream *s = (Stream *)calloc(1, sizeof(Stream));
	if(!s) return;
	pthread_mutex_init(&s->mx, NULL);
	pthread_cond_init(&s->cv, NULL);
	chiaki_log_init(&s->log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO, log_cb, NULL);

	static char host[64];   /* chiaki keeps the pointer only while connecting; one session at a time */
	snprintf(host, sizeof(host), "%s", av[1]);
	ChiakiConnectInfo ci;
	memset(&ci, 0, sizeof(ci));
	ci.ps5 = atoi(av[2]) != 0;
	ci.host = host;
	if(!b64_decode_exact(av[3], (uint8_t *)ci.regist_key, sizeof(ci.regist_key)) || !b64_decode_exact(av[4], ci.morning, sizeof(ci.morning)))
	{
		emit_event("{\"ev\":\"quit\",\"reason\":-1,\"text\":\"bad keys\",\"str\":\"\"}");
		emit_event("{\"ev\":\"closed\"}");
		free(s); return;
	}
	int res = atoi(av[5]), fps = atoi(av[6]);
	ChiakiVideoResolutionPreset rp = res >= 1080 ? CHIAKI_VIDEO_RESOLUTION_PRESET_1080p : res >= 720 ? CHIAKI_VIDEO_RESOLUTION_PRESET_720p : res >= 540 ? CHIAKI_VIDEO_RESOLUTION_PRESET_540p : CHIAKI_VIDEO_RESOLUTION_PRESET_360p;
	chiaki_connect_video_profile_preset(&ci.video_profile, rp, fps >= 60 ? CHIAKI_VIDEO_FPS_PRESET_60 : CHIAKI_VIDEO_FPS_PRESET_30);
	ci.video_profile.codec = CHIAKI_CODEC_H264;
	if(ac >= 8) { int br = atoi(av[7]); if(br >= 2000 && br <= 60000) ci.video_profile.bitrate = br; }
	ci.video_profile_auto_downgrade = true;
	ci.enable_keyboard = false;
	ci.enable_dualsense = false;
	ci.auto_regist = false;
	ci.holepunch_session = NULL;
	ci.packet_loss_max = 0.05;
	ci.enable_idr_on_fec_failure = true;

	ChiakiErrorCode err = chiaki_session_init(&s->session, &ci, &s->log);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		snprintf(buf, sizeof(buf), "{\"ev\":\"quit\",\"reason\":-1,\"text\":\"%s\",\"str\":\"\"}", chiaki_error_string(err));
		emit_event(buf); emit_event("{\"ev\":\"closed\"}");
		free(s); return;
	}
	ChiakiAudioSink sink;
	sink.user = s;
	sink.header_cb = audio_header_cb;
	sink.frame_cb = audio_frame_cb;
	chiaki_session_set_audio_sink(&s->session, &sink);
	chiaki_session_set_video_sample_cb(&s->session, video_cb, s);
	chiaki_session_set_event_cb(&s->session, event_cb, s);
	pthread_mutex_lock(&q_mx); drop_video = false; pthread_mutex_unlock(&q_mx);
	err = chiaki_session_start(&s->session);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		snprintf(buf, sizeof(buf), "{\"ev\":\"quit\",\"reason\":-1,\"text\":\"%s\",\"str\":\"\"}", chiaki_error_string(err));
		emit_event(buf); emit_event("{\"ev\":\"closed\"}");
		chiaki_session_fini(&s->session);
		free(s); return;
	}
	pthread_mutex_lock(&st_mx); cur = s; s->started = true; pthread_mutex_unlock(&st_mx);
	if(pthread_create(&s->th, NULL, stream_thread, s) == 0) pthread_detach(s->th);
	hlog("stream %s ps5=%d %dp%d", host, ci.ps5 ? 1 : 0, res, fps);
}

/* ================= finding and waking the console (same packets as chiaki-ng) ================= */

/* where to ask on the home network: everyone (255.255.255.255), each network's broadcast address, and every
   address of the phone's own network one by one (the iPhone may not send broadcasts without an Apple permission) */
static size_t lan_targets(uint32_t *t, size_t cap, const char *extra)
{
	size_t nt = 0;
	t[nt++] = 0xffffffffu;
	if(extra && *extra) { struct in_addr a; if(inet_pton(AF_INET, extra, &a) == 1) t[nt++] = ntohl(a.s_addr); }
	struct ifaddrs *ifs = NULL;
	if(getifaddrs(&ifs) == 0)
	{
		for(struct ifaddrs *i = ifs; i; i = i->ifa_next)
		{
			if(!i->ifa_addr || i->ifa_addr->sa_family != AF_INET || !i->ifa_netmask) continue;
			if(i->ifa_flags & IFF_LOOPBACK) continue;
			uint32_t ip = ntohl(((struct sockaddr_in *)i->ifa_addr)->sin_addr.s_addr);
			uint32_t mask = ntohl(((struct sockaddr_in *)i->ifa_netmask)->sin_addr.s_addr);
			if((ip >> 24) == 169 || (ip >> 24) == 127) continue;
			uint32_t net = ip & mask, bc = net | ~mask;
			if(nt < cap) t[nt++] = bc;
			uint32_t hosts = ~mask;
			if(hosts > 1 && hosts <= 1024)
				for(uint32_t h = 1; h < hosts && nt < cap; h++) { uint32_t a = net | h; if(a != ip) t[nt++] = a; }
		}
		freeifaddrs(ifs);
	}
	return nt;
}

/* the Hóng Sub TV app (Android TV) answers "HONGSUB_TV?" on UDP 8766 with a little JSON about itself */
static void cmd_tvfind(int ms)
{
	if(ms < 300 || ms > 8000) ms = 1800;
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if(fd < 0) { emit_event("{\"ev\":\"tvfind\",\"list\":[]}"); return; }
	int one = 1; setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));
	struct sockaddr_in me; memset(&me, 0, sizeof(me)); me.sin_family = AF_INET; me.sin_addr.s_addr = htonl(INADDR_ANY);
	bind(fd, (struct sockaddr *)&me, sizeof(me));
	uint32_t *t = (uint32_t *)malloc(sizeof(uint32_t) * 4200);
	char *out = (char *)malloc(32768);
	if(!t || !out) { free(t); free(out); close(fd); return; }
	size_t nt = lan_targets(t, 4200, NULL), on = 0; int found = 0;
	char seen[40][20]; int nseen = 0;
	on += (size_t)snprintf(out, 32768, "{\"ev\":\"tvfind\",\"list\":[");
	static const char q[] = "HONGSUB_TV?";
	uint64_t t0 = now_ms(), end = t0 + (uint64_t)ms; int round = 0;
	while(now_ms() < end)
	{
		if(round < 3 && now_ms() >= t0 + (uint64_t)round * 450)
		{
			for(size_t k = 0; k < nt; k++)
			{
				struct sockaddr_in to; memset(&to, 0, sizeof(to)); to.sin_family = AF_INET; to.sin_addr.s_addr = htonl(t[k]); to.sin_port = htons(8766);
				sendto(fd, q, sizeof(q) - 1, 0, (struct sockaddr *)&to, sizeof(to));
			}
			round++;
		}
		fd_set rf; FD_ZERO(&rf); FD_SET(fd, &rf);
		struct timeval tv = { 0, 100000 };
		if(select(fd + 1, &rf, NULL, NULL, &tv) <= 0) continue;
		char rb[1500]; struct sockaddr_in from; socklen_t fl = sizeof(from);
		ssize_t r = recvfrom(fd, rb, sizeof(rb) - 1, 0, (struct sockaddr *)&from, &fl);
		if(r <= 0) continue;
		rb[r] = 0;
		if(!strstr(rb, "hongsubtv")) continue;
		if(fl < (socklen_t)sizeof(from) || from.sin_family != AF_INET || from.sin_addr.s_addr == 0) continue;   /* a reply without the sender's address (seen on iPhones) is no use */
		char addr[20]; inet_ntop(AF_INET, &from.sin_addr, addr, sizeof(addr));
		bool dup = false; for(int k = 0; k < nseen; k++) if(!strcmp(seen[k], addr)) dup = true;
		if(dup || nseen >= 40) continue;
		snprintf(seen[nseen++], sizeof(seen[0]), "%s", addr);
		char esc[3200]; json_str(esc, sizeof(esc), rb);
		if(on + strlen(esc) + 64 < 32768)
			on += (size_t)snprintf(out + on, 32768 - on, "%s{\"addr\":\"%s\",\"text\":\"%s\"}", found++ ? "," : "", addr, esc);
	}
	snprintf(out + on, 32768 - on, "]}");
	emit_event(out);
	free(out); free(t); close(fd);
}

/* straight to the TV app on the home network: HTTP to <ip>:8765 (GET /ping, POST /sub with the line) */
typedef struct { char id[40]; char ip[40]; char path[64]; char *body; } TvPost;
static void *tvpost_thread(void *arg)
{
	TvPost *j = (TvPost *)arg;
	int status = 0; char resp[4096] = {0}; size_t rn = 0;
	/* "ip" or "ip:port" (default 8765, the Android TV app; 8001 asks a TV Samsung, others an LG's description) */
	int port = 8765; char *pc = strchr(j->ip, ':'); if(pc) { *pc = 0; port = atoi(pc + 1); if(port <= 0 || port > 65535) port = 8765; }
	struct sockaddr_in to; memset(&to, 0, sizeof(to)); to.sin_family = AF_INET; to.sin_port = htons((uint16_t)port);
	int fd = -1;
	if(inet_pton(AF_INET, j->ip, &to.sin_addr) == 1 && (fd = socket(AF_INET, SOCK_STREAM, 0)) >= 0)
	{
		struct timeval tv = { 3, 0 };
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)); setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#ifdef SO_NOSIGPIPE
		int one = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
		/* connect with a time limit: a TV that is off must not keep the line waiting */
		int fl = fcntl(fd, F_GETFL, 0); fcntl(fd, F_SETFL, fl | O_NONBLOCK);
		int c = connect(fd, (struct sockaddr *)&to, sizeof(to));
		bool ok = c == 0;
		if(!ok && errno == EINPROGRESS)
		{
			fd_set wf; FD_ZERO(&wf); FD_SET(fd, &wf); struct timeval ct = { 2, 500000 };
			if(select(fd + 1, NULL, &wf, NULL, &ct) == 1) { int e = 0; socklen_t el = sizeof(e); getsockopt(fd, SOL_SOCKET, SO_ERROR, &e, &el); ok = e == 0; }
		}
		fcntl(fd, F_SETFL, fl);
		if(ok)
		{
			size_t bl = j->body ? strlen(j->body) : 0;
			char h[400];
			int hn = snprintf(h, sizeof(h), "%s %s HTTP/1.0\r\nHost: %s:%d\r\nContent-Type: application/json\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",
				bl ? "POST" : "GET", j->path, j->ip, port, (unsigned)bl);
			if(send_all(fd, (const uint8_t *)h, (size_t)hn) && (!bl || send_all(fd, (const uint8_t *)j->body, bl)))
			{
				ssize_t r;
				while(rn + 1 < sizeof(resp) && (r = recv(fd, resp + rn, sizeof(resp) - 1 - rn, 0)) > 0) rn += (size_t)r;
				resp[rn] = 0;
				if(!strncmp(resp, "HTTP/", 5)) { const char *sp = strchr(resp, ' '); if(sp) status = atoi(sp + 1); }
			}
		}
		close(fd);
	}
	const char *b = strstr(resp, "\r\n\r\n"); b = b ? b + 4 : "";
	char esc[3000]; json_str(esc, sizeof(esc), b);
	char *out = (char *)malloc(3300);
	if(out)
	{
		char idq[60]; json_str(idq, sizeof(idq), j->id);
		snprintf(out, 3300, "{\"ev\":\"tvpost\",\"id\":\"%s\",\"status\":%d,\"body\":\"%s\"}", idq, status, esc);
		emit_event(out); free(out);
	}
	free(j->body); free(j);
	return NULL;
}
/* "tvpost <id> <ip> <path>" then, on the next line, the JSON to send (none: GET) */
static void cmd_tvpost(char *msg)
{
	char *nl = strchr(msg, '\n'); if(nl) *nl = 0;
	char *av[5]; int ac = split(msg, av, 5);
	if(ac < 4) return;
	TvPost *j = (TvPost *)calloc(1, sizeof(TvPost)); if(!j) return;
	snprintf(j->id, sizeof(j->id), "%s", av[1]); snprintf(j->ip, sizeof(j->ip), "%s", av[2]); snprintf(j->path, sizeof(j->path), "%s", av[3]);
	if(j->path[0] != '/' || strstr(j->path, "..")) { free(j); return; }
	if(nl && nl[1]) j->body = strdup(nl + 1);
	pthread_t th; if(pthread_create(&th, NULL, tvpost_thread, j) == 0) pthread_detach(th); else { free(j->body); free(j); }
}

/* ---- TV LG / Samsung: the phone answers the TV app's questions on the home network (hslan.c) ---- */
static void cmd_lanon(const char *hint)
{
	char ips[200], esc[260], out[400];
	int port = hslan_on(hint, ips, sizeof(ips));
	json_str(esc, sizeof(esc), ips);
	snprintf(out, sizeof(out), "{\"ev\":\"lan\",\"port\":%d,\"ips\":\"%s\"}", port, esc);
	emit_event(out);
}
/* "lanpush <code>" then, on the next line, the message (JSON) */
static void cmd_lanpush(char *msg)
{
	char *nl = strchr(msg, '\n'); if(!nl) return; *nl = 0;
	char *av[3]; int ac = split(msg, av, 3);
	if(ac >= 2) hslan_push(av[1], nl + 1);
}
static void cmd_lanseen(const char *code)
{
	char ver[24], codes[80], ev[40], ec[100], cq[20], out[300];
	long long ago = hslan_seen(code, ver, sizeof(ver)); hslan_codes(codes, sizeof(codes));
	json_str(ev, sizeof(ev), ver); json_str(ec, sizeof(ec), codes); json_str(cq, sizeof(cq), code);
	snprintf(out, sizeof(out), "{\"ev\":\"lanseen\",\"id\":\"%s\",\"ago\":%lld,\"ver\":\"%s\",\"codes\":\"%s\"}", cq, ago, ev, ec);
	emit_event(out);
}
static void *lanfind_thread(void *arg)
{
	int ms = (int)(intptr_t)arg;
	char *out = (char *)malloc(65536); if(!out) return NULL;
	hslan_find(ms, out, 65536); emit_event(out); free(out);
	return NULL;
}

static void cmd_discover(int ms, const char *extra)
{
	if(ms < 300 || ms > 10000) ms = 1600;
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if(fd < 0) { emit_event("{\"ev\":\"discover\",\"list\":[],\"err\":\"socket\"}"); return; }
	int one = 1;
	setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));
	struct sockaddr_in me; memset(&me, 0, sizeof(me)); me.sin_family = AF_INET; me.sin_addr.s_addr = htonl(INADDR_ANY);
	bind(fd, (struct sockaddr *)&me, sizeof(me));

	uint32_t *t = (uint32_t *)malloc(sizeof(uint32_t) * 4200);
	if(!t) { close(fd); return; }
	size_t nt = lan_targets(t, 4200, extra);
	static const char pk5[] = "SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n";
	static const char pk4[] = "SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00020020\n";

	char *out = (char *)malloc(65536); size_t on = 0; int found = 0;
	char seen[40][20]; int nseen = 0;
	if(!out) { free(t); close(fd); return; }
	on += (size_t)snprintf(out, 65536, "{\"ev\":\"discover\",\"list\":[");
	uint64_t t0 = now_ms(), end = t0 + (uint64_t)ms;
	int round = 0;
	while(now_ms() < end)
	{
		if(round < 2 && now_ms() >= t0 + (uint64_t)round * 500)
		{
			for(size_t k = 0; k < nt; k++)
			{
				struct sockaddr_in to; memset(&to, 0, sizeof(to)); to.sin_family = AF_INET; to.sin_addr.s_addr = htonl(t[k]);
				to.sin_port = htons(9302); sendto(fd, pk5, sizeof(pk5), 0, (struct sockaddr *)&to, sizeof(to));
				to.sin_port = htons(987); sendto(fd, pk4, sizeof(pk4), 0, (struct sockaddr *)&to, sizeof(to));
			}
			round++;
		}
		fd_set rf; FD_ZERO(&rf); FD_SET(fd, &rf);
		struct timeval tv = { 0, 100000 };
		if(select(fd + 1, &rf, NULL, NULL, &tv) <= 0) continue;
		char rb[2048]; struct sockaddr_in from; socklen_t fl = sizeof(from);
		ssize_t r = recvfrom(fd, rb, sizeof(rb) - 1, 0, (struct sockaddr *)&from, &fl);
		if(r <= 0) continue;
		rb[r] = 0;
		if(strncmp(rb, "HTTP/1.1", 8) != 0) continue;
		if(fl < (socklen_t)sizeof(from) || from.sin_family != AF_INET || from.sin_addr.s_addr == 0) continue;   /* a reply without the console's address (seen on iPhones): pairing with 0.0.0.0 failed every time */
		char addr[20]; inet_ntop(AF_INET, &from.sin_addr, addr, sizeof(addr));
		bool dup = false; for(int k = 0; k < nseen; k++) if(!strcmp(seen[k], addr)) dup = true;
		if(dup || nseen >= 40) continue;
		snprintf(seen[nseen++], sizeof(seen[0]), "%s", addr);
		char esc[4200]; json_str(esc, sizeof(esc), rb);
		if(on + strlen(esc) + 64 < 65536)
			on += (size_t)snprintf(out + on, 65536 - on, "%s{\"addr\":\"%s\",\"text\":\"%s\"}", found++ ? "," : "", addr, esc);
	}
	snprintf(out + on, 65536 - on, "],\"asked\":%u}", (unsigned)nt);
	emit_event(out);
	free(out); free(t); close(fd);
}

static void cmd_wake(const char *ip, int ps5, const char *cred)
{
	char pk[512];
	int n = snprintf(pk, sizeof(pk), "WAKEUP * HTTP/1.1\nclient-type:vr\nauth-type:R\nmodel:w\napp-type:r\nuser-credential:%s\ndevice-discovery-protocol-version:%s\n",
		cred, ps5 ? "00030010" : "00020020");
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	bool ok = false;
	if(fd >= 0)
	{
		int one = 1; setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));
		struct sockaddr_in to; memset(&to, 0, sizeof(to)); to.sin_family = AF_INET; to.sin_port = htons(ps5 ? 9302 : 987);
		if(inet_pton(AF_INET, ip, &to.sin_addr) == 1)
			ok = sendto(fd, pk, (size_t)n + 1, 0, (struct sockaddr *)&to, sizeof(to)) > 0;
		close(fd);
	}
	char buf[96]; snprintf(buf, sizeof(buf), "{\"ev\":\"wake\",\"ok\":%s}", ok ? "true" : "false");
	emit_event(buf);
}


#ifdef HSRP_TEST_CMDS
/* testing on a computer: play an H.264 file as if the console sent it ("feed <file> <fps>") */
typedef struct { char path[512]; int fps; } FeedJob;
static void *feed_thread(void *arg)
{
	FeedJob *j = (FeedJob *)arg;
	FILE *f = fopen(j->path, "rb");
	if(!f) { emit_event("{\"ev\":\"quit\",\"reason\":-1,\"text\":\"no file\",\"str\":\"\"}"); free(j); return NULL; }
	fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
	uint8_t *d = (uint8_t *)malloc((size_t)n); if(fread(d, 1, (size_t)n, f) != (size_t)n) n = 0; fclose(f);
	emit_event("{\"ev\":\"connected\"}");
	/* one packet per picture: cut before every slice NAL (1 or 5) that starts a new picture, keeping SPS/PPS with the key frame */
	size_t start = 0; bool have_slice = false;
	for(size_t i = 0; i + 4 <= (size_t)n; i++)
	{
		if(d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1)
		{
			size_t sc = (i > 0 && d[i - 1] == 0) ? i - 1 : i;
			int t = d[i + 3] & 31;
			bool first_mb = (t == 1 || t == 5) && (d[i + 4] & 0x80);
			if((t == 1 || t == 5) && first_mb && have_slice) { uint8_t pre[5] = {0}; emit(1, pre, 5, d + start, sc - start); start = sc; have_slice = false; usleep(1000000 / (j->fps > 0 ? j->fps : 30)); }
			if((t == 7 || t == 9) && have_slice) { uint8_t pre[5] = {0}; emit(1, pre, 5, d + start, sc - start); start = sc; have_slice = false; usleep(1000000 / (j->fps > 0 ? j->fps : 30)); }
			if(t == 1 || t == 5) have_slice = true;
			i += 2;
		}
	}
	if((size_t)n > start) { uint8_t pre[5] = {0}; emit(1, pre, 5, d + start, (size_t)n - start); }
	free(d); free(j);
	return NULL;
}
#endif

/* ================= commands from the page ================= */

static int split(char *s, char **av, int max)
{
	int n = 0;
	while(*s && n < max)
	{
		while(*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;
		if(!*s) break;
		av[n++] = s;
		while(*s && *s != ' ' && *s != '\t' && *s != '\r' && *s != '\n') s++;
		if(*s) *s++ = 0;
	}
	return n;
}

typedef struct { int ms; char extra[64]; } DiscJob;
static void *tvfind_thread(void *arg) { int ms = (int)(intptr_t)arg; cmd_tvfind(ms); return NULL; }
static void *discover_thread(void *arg) { DiscJob *j = (DiscJob *)arg; cmd_discover(j->ms, j->extra); free(j); return NULL; }

static void command(char *line)
{
	if(line[0] == 'c' && line[1] == ' ')
	{
		unsigned long buttons = 0; int l2 = 0, r2 = 0, lx = 0, ly = 0, rx = 0, ry = 0;
		if(sscanf(line + 1, "%lu %d %d %d %d %d %d", &buttons, &l2, &r2, &lx, &ly, &rx, &ry) != 7) return;
		ChiakiControllerState st; chiaki_controller_state_set_idle(&st);
		st.buttons = (uint32_t)buttons;
		st.l2_state = (uint8_t)(l2 < 0 ? 0 : l2 > 255 ? 255 : l2);
		st.r2_state = (uint8_t)(r2 < 0 ? 0 : r2 > 255 ? 255 : r2);
		st.left_x = (int16_t)lx; st.left_y = (int16_t)ly; st.right_x = (int16_t)rx; st.right_y = (int16_t)ry;
		pthread_mutex_lock(&st_mx); if(cur && cur->started) chiaki_session_set_controller_state(&cur->session, &st); pthread_mutex_unlock(&st_mx);
		return;
	}
	char *av[12]; int ac = split(line, av, 12);
	if(ac == 0) return;
	const char *c = av[0];
	if(!strcmp(c, "p"))
	{
		const char *pin = ac > 1 ? av[1] : "";
		pthread_mutex_lock(&st_mx); if(cur && cur->started) chiaki_session_set_login_pin(&cur->session, (const uint8_t *)pin, strlen(pin)); pthread_mutex_unlock(&st_mx);
	}
	else if(!strcmp(c, "i")) { pthread_mutex_lock(&st_mx); if(cur && cur->started) { last_idr = now_ms(); chiaki_session_request_idr(&cur->session); } pthread_mutex_unlock(&st_mx); }
	else if(!strcmp(c, "s")) stream_stop(true);
	else if(!strcmp(c, "q")) stream_stop(false);
	else if(!strcmp(c, "stream")) stream_start(av, ac);
	else if(!strcmp(c, "regist") && ac >= 5)
	{
		pthread_mutex_lock(&reg_mx);
		if(reg_busy) { pthread_mutex_unlock(&reg_mx); emit_event("{\"ev\":\"regist\",\"ok\":false,\"err\":\"busy\"}"); return; }
		reg_busy = true; pthread_mutex_unlock(&reg_mx);
		RegistJob *j = (RegistJob *)calloc(1, sizeof(RegistJob));
		snprintf(j->host, sizeof(j->host), "%s", av[1]); j->ps5 = atoi(av[2]);
		snprintf(j->account, sizeof(j->account), "%s", av[3]); snprintf(j->pin, sizeof(j->pin), "%s", av[4]);
		pthread_t th; if(pthread_create(&th, NULL, regist_thread, j) == 0) pthread_detach(th);
	}
	else if(!strcmp(c, "discover"))
	{
		DiscJob *j = (DiscJob *)calloc(1, sizeof(DiscJob));
		j->ms = ac > 1 ? atoi(av[1]) : 1600;
		if(ac > 2) snprintf(j->extra, sizeof(j->extra), "%s", av[2]);
		pthread_t th; if(pthread_create(&th, NULL, discover_thread, j) == 0) pthread_detach(th);
	}
	else if(!strcmp(c, "wake") && ac >= 4) cmd_wake(av[1], atoi(av[2]), av[3]);
	else if(!strcmp(c, "tvfind")) { pthread_t th; if(pthread_create(&th, NULL, tvfind_thread, (void *)(intptr_t)(ac > 1 ? atoi(av[1]) : 1800)) == 0) pthread_detach(th); }
	else if(!strcmp(c, "lanon")) cmd_lanon(ac > 1 ? av[1] : NULL);
	/* TV Samsung from the phone: sdb over TCP, spoken by the page; the Samsung sign-in callback (hsnet.c) */
	else if(!strcmp(c, "tcpopen") && ac >= 4) { static bool init; if(!init) { hsnet_init(emit_event); init = true; } hsnet_tcp_open(av[1], av[2], atoi(av[3])); }
	else if(!strcmp(c, "tcpsend") && ac >= 3) hsnet_tcp_send(av[1], av[2]);
	else if(!strcmp(c, "tcpclose") && ac >= 2) hsnet_tcp_close(av[1]);
	else if(!strcmp(c, "catchon")) { hsnet_init(emit_event); hsnet_catch_on(ac > 1 ? atoi(av[1]) : 4794); }
	else if(!strcmp(c, "catchoff")) hsnet_catch_off();
	else if(!strcmp(c, "lanseen") && ac >= 2) cmd_lanseen(av[1]);
	else if(!strcmp(c, "lanfind")) { pthread_t th; if(pthread_create(&th, NULL, lanfind_thread, (void *)(intptr_t)(ac > 1 ? atoi(av[1]) : 3500)) == 0) pthread_detach(th); }
	else if(!strcmp(c, "ping")) emit_event("{\"ev\":\"pong\",\"core\":\"hsrp 2\"}");
#ifdef HSRP_TEST_CMDS
	else if(!strcmp(c, "feed") && ac >= 2)
	{
		FeedJob *j = (FeedJob *)calloc(1, sizeof(FeedJob));
		snprintf(j->path, sizeof(j->path), "%s", av[1]); j->fps = ac > 2 ? atoi(av[2]) : 30;
		pthread_t th; if(pthread_create(&th, NULL, feed_thread, j) == 0) pthread_detach(th);
	}
#endif
}

/* ================= HTTP + WebSocket server on 127.0.0.1 ================= */

static bool read_request(int fd, char *buf, size_t cap)
{
	size_t n = 0;
	while(n + 1 < cap)
	{
		ssize_t r = recv(fd, buf + n, cap - 1 - n, 0);
		if(r <= 0) return false;
		n += (size_t)r; buf[n] = 0;
		if(strstr(buf, "\r\n\r\n")) return true;
	}
	return false;
}

static const char *header(const char *req, const char *name, char *out, size_t cap)
{
	size_t nl = strlen(name);
	const char *p = req;
	while((p = strstr(p, "\r\n")))
	{
		p += 2;
		if(!strncasecmp(p, name, nl) && p[nl] == ':')
		{
			const char *v = p + nl + 1; while(*v == ' ') v++;
			size_t k = strcspn(v, "\r\n"); if(k >= cap) k = cap - 1;
			memcpy(out, v, k); out[k] = 0; return out;
		}
	}
	return NULL;
}

static void http_reply(int fd, const char *status, const char *type, const char *body)
{
	char h[300];
	int n = snprintf(h, sizeof(h), "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", status, type, (unsigned)strlen(body));
	send_all(fd, (const uint8_t *)h, (size_t)n);
	send_all(fd, (const uint8_t *)body, strlen(body));
}

static const char *mime(const char *p)
{
	const char *e = strrchr(p, '.');
	if(!e) return "application/octet-stream";
	if(!strcasecmp(e, ".html")) return "text/html; charset=utf-8";
	if(!strcasecmp(e, ".js")) return "text/javascript; charset=utf-8";
	if(!strcasecmp(e, ".css")) return "text/css; charset=utf-8";
	if(!strcasecmp(e, ".json")) return "application/json";
	if(!strcasecmp(e, ".svg")) return "image/svg+xml";
	if(!strcasecmp(e, ".png")) return "image/png";
	if(!strcasecmp(e, ".jpg")) return "image/jpeg";
	if(!strcasecmp(e, ".woff2")) return "font/woff2";
	if(!strcasecmp(e, ".wasm")) return "application/wasm";
	if(!strcasecmp(e, ".txt")) return "text/plain; charset=utf-8";
	if(!strcasecmp(e, ".mp3")) return "audio/mpeg";
	return "application/octet-stream";
}

static void serve_file(int fd, const char *path)
{
	if(!g_root[0]) { http_reply(fd, "404 Not Found", "text/plain", "no files"); return; }
	char rel[512]; size_t k = strcspn(path, "?#"); if(k >= sizeof(rel)) k = sizeof(rel) - 1;
	memcpy(rel, path, k); rel[k] = 0;
	if(strstr(rel, "..") || rel[0] != '/') { http_reply(fd, "403 Forbidden", "text/plain", "no"); return; }
	char full[1600];
	snprintf(full, sizeof(full), "%s%s", g_root, !strcmp(rel, "/") ? "/index.html" : rel);
	int f = open(full, O_RDONLY);
	struct stat sb;
	if(f < 0 || fstat(f, &sb) != 0 || !S_ISREG(sb.st_mode)) { if(f >= 0) close(f); http_reply(fd, "404 Not Found", "text/plain", "not found"); return; }
	char h[400];
	int n = snprintf(h, sizeof(h), "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %lld\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n", mime(full), (long long)sb.st_size);
	send_all(fd, (const uint8_t *)h, (size_t)n);
	uint8_t b[65536]; ssize_t r;
	while((r = read(f, b, sizeof(b))) > 0) if(!send_all(fd, b, (size_t)r)) break;
	close(f);
}

/* the page's WebSocket: read its commands until it goes away */
static void ws_session(int fd)
{
	pthread_mutex_lock(&q_mx);
	int old = ws_fd;
	ws_fd = fd; ws_gen++; queue_clear_locked();
	pthread_mutex_unlock(&q_mx);
	if(old >= 0) shutdown(old, SHUT_RDWR);
	hlog("page connected");
	uint8_t *msg = NULL; size_t msg_n = 0;
	for(;;)
	{
		uint8_t h[14];
		if(recv(fd, h, 2, MSG_WAITALL) != 2) break;
		int fin = h[0] & 0x80, op = h[0] & 0x0f, masked = h[1] & 0x80;
		uint64_t n = h[1] & 0x7f;
		if(n == 126) { if(recv(fd, h + 2, 2, MSG_WAITALL) != 2) break; n = ((uint64_t)h[2] << 8) | h[3]; }
		else if(n == 127) { if(recv(fd, h + 2, 8, MSG_WAITALL) != 8) break; n = 0; for(int i = 0; i < 8; i++) n = (n << 8) | h[2 + i]; }
		uint8_t mk[4] = {0};
		if(masked && recv(fd, mk, 4, MSG_WAITALL) != 4) break;
		if(n > 1024 * 1024) break;
		uint8_t *p = (uint8_t *)malloc((size_t)n + 1);
		if(!p) break;
		if(n && recv(fd, p, (size_t)n, MSG_WAITALL) != (ssize_t)n) { free(p); break; }
		for(uint64_t i = 0; i < n; i++) p[i] ^= mk[i & 3];
		p[n] = 0;
		if(op == 8) { free(p); break; }
		if(op == 9) { pthread_mutex_lock(&w_mx); ws_send_frame(fd, 10, p, (size_t)n); pthread_mutex_unlock(&w_mx); free(p); continue; }
		if(op == 10) { free(p); continue; }
		if(op == 1 || op == 2 || op == 0)
		{
			uint8_t *m = (uint8_t *)realloc(msg, msg_n + (size_t)n + 1);
			if(!m) { free(p); break; }
			msg = m; memcpy(msg + msg_n, p, (size_t)n); msg_n += (size_t)n; msg[msg_n] = 0;
			free(p);
			if(fin)
			{
				/* several commands may come in one message, one per line; "tvpost" carries its JSON on the next line */
				char *s = (char *)msg, *nl;
				if(!strncmp(s, "tvpost ", 7)) cmd_tvpost(s);
				else if(!strncmp(s, "lanpush ", 8)) cmd_lanpush(s);
				else while(s && *s) { nl = strchr(s, '\n'); if(nl) *nl = 0; if(*s) command(s); s = nl ? nl + 1 : NULL; }
				free(msg); msg = NULL; msg_n = 0;
			}
			continue;
		}
		free(p);
	}
	free(msg);
	pthread_mutex_lock(&q_mx);
	bool mine = ws_fd == fd;
	if(mine) { ws_fd = -1; ws_gen++; queue_clear_locked(); }
	pthread_mutex_unlock(&q_mx);
	close(fd);
	hlog("page left");
	/* the page closed (app reloaded, quit): end the Remote Play session it was running */
	if(mine) stream_stop(false);
}

static void *conn_thread(void *arg)
{
	int fd = (int)(intptr_t)arg;
	char req[8192];
	struct timeval tv = { 10, 0 };
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
	if(!read_request(fd, req, sizeof(req))) { close(fd); return NULL; }
	char method[8] = {0}, path[2048] = {0};
	if(sscanf(req, "%7s %2047s", method, path) != 2) { close(fd); return NULL; }
	char up[64], key[128];
	if(header(req, "Upgrade", up, sizeof(up)) && !strcasecmp(up, "websocket") && header(req, "Sec-WebSocket-Key", key, sizeof(key)))
	{
		/* only the app's own page: it knows the token */
		char want[120]; snprintf(want, sizeof(want), "t=%s", g_token);
		const char *q = strchr(path, '?');
		if(strncmp(path, "/ws", 3) != 0 || !q || !strstr(q, want)) { http_reply(fd, "403 Forbidden", "text/plain", "no"); close(fd); return NULL; }
		char src[200]; snprintf(src, sizeof(src), "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
		uint8_t sha[20]; mbedtls_sha1_ret((const unsigned char *)src, strlen(src), sha);
		char acc[64] = {0}; chiaki_base64_encode(sha, 20, acc, sizeof(acc));
		char resp[300];
		int n = snprintf(resp, sizeof(resp), "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", acc);
		if(!send_all(fd, (const uint8_t *)resp, (size_t)n)) { close(fd); return NULL; }
		struct timeval no = { 0, 0 };
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &no, sizeof(no));
		int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
		int sb = 1024 * 1024; setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sb, sizeof(sb));
#ifdef SO_NOSIGPIPE
		setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
		ws_session(fd);
		return NULL;
	}
	if(strcmp(method, "GET") != 0) http_reply(fd, "405 Method Not Allowed", "text/plain", "GET only");
	else serve_file(fd, path);
	close(fd);
	return NULL;
}

static int listen_on(int port)
{
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if(fd < 0) return -1;
	int one = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	struct sockaddr_in a; memset(&a, 0, sizeof(a));
	a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons((uint16_t)port);
	if(bind(fd, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(fd, 16) != 0) { close(fd); return -1; }
	return fd;
}

static int g_port = 0;
static void relisten(void)
{
	if(g_port <= 0) return;
	int old = g_listen;
	if(old >= 0) close(old);
	for(int i = 0; i < 20; i++)
	{
		int fd = listen_on(g_port);
		if(fd >= 0) { g_listen = fd; hlog("hsrp listening again on 127.0.0.1:%d", g_port); return; }
		sleep_ms(250);
	}
	hlog("hsrp could not listen again on %d", g_port);
}

static void *accept_thread(void *arg)
{
	(void)arg;
	int bad = 0;
	for(;;)
	{
		int c = accept(g_listen, NULL, NULL);
		if(c < 0)
		{
			if(errno == EINTR) continue;
			/* iOS takes the listening socket back while the app is in the background: every accept() then fails
			   (ECONNABORTED, at once) and the page could no longer reach the PS5 part ("thiếu thành phần kết nối",
			   report 1160). After a run of failures, listen again on the same port */
			if(++bad >= 5) { relisten(); bad = 0; }
			sleep_ms(errno == ECONNABORTED ? 50 : 200);
			continue;
		}
		bad = 0;
#ifdef SO_NOSIGPIPE
		int one = 1; setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
		pthread_t th;
		if(pthread_create(&th, NULL, conn_thread, (void *)(intptr_t)c) == 0) pthread_detach(th);
		else close(c);
	}
	return NULL;
}

int hsrp_start(int port, const char *token, const char *web_root)
{
	if(g_listen >= 0)
	{
		struct sockaddr_in a; socklen_t al = sizeof(a);
		getsockname(g_listen, (struct sockaddr *)&a, &al);
		return ntohs(a.sin_port);
	}
	signal(SIGPIPE, SIG_IGN);
	snprintf(g_token, sizeof(g_token), "%s", token ? token : "");
	snprintf(g_root, sizeof(g_root), "%s", web_root ? web_root : "");
	if(chiaki_lib_init() != CHIAKI_ERR_SUCCESS) { hlog("chiaki_lib_init failed"); return -1; }
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if(fd < 0) return -1;
	int one = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	struct sockaddr_in a; memset(&a, 0, sizeof(a));
	a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons((uint16_t)port);
	if(bind(fd, (struct sockaddr *)&a, sizeof(a)) != 0)
	{
		/* the usual port is taken: any free one */
		a.sin_port = 0;
		if(bind(fd, (struct sockaddr *)&a, sizeof(a)) != 0) { close(fd); return -1; }
	}
	if(listen(fd, 16) != 0) { close(fd); return -1; }
	socklen_t al = sizeof(a);
	getsockname(fd, (struct sockaddr *)&a, &al);
	g_listen = fd;
	g_port = ntohs(a.sin_port);
	pthread_t th;
	pthread_create(&th, NULL, writer_thread, NULL); pthread_detach(th);
	pthread_create(&th, NULL, accept_thread, NULL); pthread_detach(th);
	hlog("hsrp listening on 127.0.0.1:%d", ntohs(a.sin_port));
	return ntohs(a.sin_port);
}
