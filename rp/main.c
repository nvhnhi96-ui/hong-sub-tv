// SPDX-License-Identifier: AGPL-3.0-only
// hongsub-rp: small Remote Play bridge for Hóng Sub, built on chiaki-ng's chiaki-lib (AGPL-3.0).
//
//   hongsub-rp regist <host> <ps5 0|1> <psn_account_id_base64> <pin>
//       prints one JSON line: {"ok":true,"regist_key":"<b64>","morning":"<b64>","nickname":"...","mac":"..."}
//
//   hongsub-rp stream <host> <ps5 0|1> <regist_key_b64> <morning_b64> <res 360|540|720|1080> <fps 30|60>
//       stdout: binary packets  [u8 type][u32 length LE][payload]
//         1 = video sample (H.264 Annex B), payload: [u8 flags bit0=recovered][i32 frames_lost LE][data]
//         2 = audio header JSON  3 = audio packet (Opus)  9 = JSON event
//       stdin: text lines
//         c <buttons> <l2> <r2> <lx> <ly> <rx> <ry>   controller state
//         p <pin>                                       console login passcode
//         i                                             request key frame
//         s                                             put console to rest mode and quit
//         q                                             quit

#include <chiaki/common.h>
#include <chiaki/log.h>
#include <chiaki/session.h>
#include <chiaki/regist.h>
#include <chiaki/base64.h>
#include <chiaki/controller.h>
#include <chiaki/thread.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#include <windows.h>
#define SLEEP_MS(ms) Sleep(ms)
#else
#include <unistd.h>
#define SLEEP_MS(ms) usleep((ms) * 1000)
#endif

static ChiakiMutex out_mutex;
static volatile int quit_flag = 0;

static void put_u32(uint8_t *p, uint32_t v) { p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; p[2] = (v >> 16) & 0xff; p[3] = (v >> 24) & 0xff; }

static void emit(uint8_t type, const uint8_t *a, size_t a_len, const uint8_t *b, size_t b_len)
{
	uint8_t hdr[5];
	hdr[0] = type;
	put_u32(hdr + 1, (uint32_t)(a_len + b_len));
	chiaki_mutex_lock(&out_mutex);
	fwrite(hdr, 1, 5, stdout);
	if(a_len) fwrite(a, 1, a_len, stdout);
	if(b_len) fwrite(b, 1, b_len, stdout);
	fflush(stdout);
	chiaki_mutex_unlock(&out_mutex);
}

// JSON string escaping into a fixed buffer
static void json_str(char *out, size_t out_size, const char *s)
{
	size_t o = 0;
	if(!s) s = "";
	for(; *s && o + 7 < out_size; s++)
	{
		unsigned char c = (unsigned char)*s;
		if(c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = (char)c; }
		else if(c == '\n') { out[o++] = '\\'; out[o++] = 'n'; }
		else if(c == '\r' || c == '\t') { out[o++] = ' '; }
		else if(c < 0x20) { o += snprintf(out + o, out_size - o, "\\u%04x", c); }
		else out[o++] = (char)c;
	}
	out[o] = 0;
}

static void emit_event(const char *json)
{
	emit(9, (const uint8_t *)json, strlen(json), NULL, 0);
}

static bool stream_mode = false;

static void log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	char esc[1200];
	json_str(esc, sizeof(esc), msg);
	if(stream_mode)
	{
		char buf[1400];
		snprintf(buf, sizeof(buf), "{\"ev\":\"log\",\"level\":%d,\"msg\":\"%s\"}", (int)level, esc);
		emit_event(buf);
	}
	else
	{
		fprintf(stderr, "[%d] %s\n", (int)level, msg);
	}
}

static bool b64_decode_exact(const char *in, uint8_t *out, size_t want)
{
	uint8_t tmp[256];
	size_t n = sizeof(tmp);
	if(chiaki_base64_decode(in, strlen(in), tmp, &n) != CHIAKI_ERR_SUCCESS)
		return false;
	if(n < want)
		return false;
	memcpy(out, tmp, want);
	return true;
}

/* ---------------- regist ---------------- */

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
			"{\"ok\":true,\"regist_key\":\"%s\",\"morning\":\"%s\",\"nickname\":\"%s\",\"mac\":\"%02x%02x%02x%02x%02x%02x\",\"target\":%d}",
			key_b64, morning_b64, nick,
			h->server_mac[0], h->server_mac[1], h->server_mac[2], h->server_mac[3], h->server_mac[4], h->server_mac[5],
			(int)h->target);
	}
	else if(event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_CANCELED)
		snprintf(regist_result, sizeof(regist_result), "{\"ok\":false,\"err\":\"canceled\"}");
	else
		snprintf(regist_result, sizeof(regist_result), "{\"ok\":false,\"err\":\"failed\"}");
	regist_done = 1;
}

static int cmd_regist(int argc, char **argv)
{
	if(argc < 6) { printf("{\"ok\":false,\"err\":\"usage\"}\n"); return 2; }
	ChiakiLog log;
	chiaki_log_init(&log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO, log_cb, NULL);

	ChiakiRegistInfo info;
	memset(&info, 0, sizeof(info));
	bool ps5 = atoi(argv[3]) != 0;
	info.target = ps5 ? CHIAKI_TARGET_PS5_1 : CHIAKI_TARGET_PS4_10;
	info.host = argv[2];
	info.broadcast = false;
	info.psn_online_id = NULL;
	if(!b64_decode_exact(argv[4], info.psn_account_id, CHIAKI_PSN_ACCOUNT_ID_SIZE))
	{
		printf("{\"ok\":false,\"err\":\"account\"}\n");
		return 2;
	}
	info.pin = (uint32_t)strtoul(argv[5], NULL, 10);
	info.console_pin = 0;
	info.holepunch_info = NULL;

	ChiakiRegist regist;
	ChiakiErrorCode err = chiaki_regist_start(&regist, &log, &info, regist_cb, NULL);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		printf("{\"ok\":false,\"err\":\"%s\"}\n", chiaki_error_string(err));
		return 1;
	}
	for(int i = 0; i < 300 && !regist_done; i++)
		SLEEP_MS(100);
	if(!regist_done)
	{
		chiaki_regist_stop(&regist);
		snprintf(regist_result, sizeof(regist_result), "{\"ok\":false,\"err\":\"timeout\"}");
	}
	chiaki_regist_fini(&regist);
	printf("%s\n", regist_result);
	fflush(stdout);
	return strstr(regist_result, "\"ok\":true") ? 0 : 1;
}

/* ---------------- stream ---------------- */

static ChiakiSession session;

static bool video_cb(uint8_t *buf, size_t buf_size, int32_t frames_lost, bool frame_recovered, void *user)
{
	(void)user;
	uint8_t pre[5];
	pre[0] = frame_recovered ? 1 : 0;
	put_u32(pre + 1, (uint32_t)frames_lost);
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

static void audio_frame_cb(uint8_t *buf, size_t buf_size, void *user)
{
	(void)user;
	emit(3, buf, buf_size, NULL, 0);
}

static void event_cb(ChiakiEvent *event, void *user)
{
	(void)user;
	char buf[512], esc[256];
	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED:
			emit_event("{\"ev\":\"connected\"}");
			break;
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
			quit_flag = 1;
			break;
		case CHIAKI_EVENT_RUMBLE:
			snprintf(buf, sizeof(buf), "{\"ev\":\"rumble\",\"l\":%u,\"r\":%u}", (unsigned)event->rumble.left, (unsigned)event->rumble.right);
			emit_event(buf);
			break;
		default:
			break;
	}
}

static int cmd_stream(int argc, char **argv)
{
	if(argc < 8) { fprintf(stderr, "usage\n"); return 2; }
	stream_mode = true;
	ChiakiLog log;
	chiaki_log_init(&log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO, log_cb, NULL);

	ChiakiConnectInfo ci;
	memset(&ci, 0, sizeof(ci));
	ci.ps5 = atoi(argv[3]) != 0;
	ci.host = argv[2];
	if(!b64_decode_exact(argv[4], (uint8_t *)ci.regist_key, sizeof(ci.regist_key)) || !b64_decode_exact(argv[5], ci.morning, sizeof(ci.morning)))
	{
		emit_event("{\"ev\":\"quit\",\"reason\":-1,\"text\":\"bad keys\",\"str\":\"\"}");
		return 2;
	}
	int res = atoi(argv[6]), fps = atoi(argv[7]);
	ChiakiVideoResolutionPreset rp = res >= 1080 ? CHIAKI_VIDEO_RESOLUTION_PRESET_1080p : res >= 720 ? CHIAKI_VIDEO_RESOLUTION_PRESET_720p : res >= 540 ? CHIAKI_VIDEO_RESOLUTION_PRESET_540p : CHIAKI_VIDEO_RESOLUTION_PRESET_360p;
	chiaki_connect_video_profile_preset(&ci.video_profile, rp, fps >= 60 ? CHIAKI_VIDEO_FPS_PRESET_60 : CHIAKI_VIDEO_FPS_PRESET_30);
	ci.video_profile.codec = CHIAKI_CODEC_H264; // decoded by the app with WebCodecs
	ci.video_profile_auto_downgrade = true;
	ci.enable_keyboard = false;
	ci.enable_dualsense = false;
	ci.auto_regist = false;
	ci.holepunch_session = NULL;
	ci.packet_loss_max = 0.05;
	ci.enable_idr_on_fec_failure = true;

	ChiakiErrorCode err = chiaki_session_init(&session, &ci, &log);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		char buf[256];
		snprintf(buf, sizeof(buf), "{\"ev\":\"quit\",\"reason\":-1,\"text\":\"%s\",\"str\":\"\"}", chiaki_error_string(err));
		emit_event(buf);
		return 1;
	}
	ChiakiAudioSink sink;
	sink.user = NULL;
	sink.header_cb = audio_header_cb;
	sink.frame_cb = audio_frame_cb;
	chiaki_session_set_audio_sink(&session, &sink);
	chiaki_session_set_video_sample_cb(&session, video_cb, NULL);
	chiaki_session_set_event_cb(&session, event_cb, NULL);

	err = chiaki_session_start(&session);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		char buf[256];
		snprintf(buf, sizeof(buf), "{\"ev\":\"quit\",\"reason\":-1,\"text\":\"%s\",\"str\":\"\"}", chiaki_error_string(err));
		emit_event(buf);
		chiaki_session_fini(&session);
		return 1;
	}

	char line[256];
	ChiakiControllerState st;
	chiaki_controller_state_set_idle(&st);
	while(!quit_flag && fgets(line, sizeof(line), stdin))
	{
		if(line[0] == 'c')
		{
			unsigned long buttons = 0;
			int l2 = 0, r2 = 0, lx = 0, ly = 0, rx = 0, ry = 0;
			if(sscanf(line + 1, "%lu %d %d %d %d %d %d", &buttons, &l2, &r2, &lx, &ly, &rx, &ry) == 7)
			{
				chiaki_controller_state_set_idle(&st);
				st.buttons = (uint32_t)buttons;
				st.l2_state = (uint8_t)(l2 < 0 ? 0 : l2 > 255 ? 255 : l2);
				st.r2_state = (uint8_t)(r2 < 0 ? 0 : r2 > 255 ? 255 : r2);
				st.left_x = (int16_t)lx; st.left_y = (int16_t)ly;
				st.right_x = (int16_t)rx; st.right_y = (int16_t)ry;
				chiaki_session_set_controller_state(&session, &st);
			}
		}
		else if(line[0] == 'p')
		{
			char *pin = line + 1;
			while(*pin == ' ') pin++;
			size_t n = strcspn(pin, "\r\n");
			chiaki_session_set_login_pin(&session, (const uint8_t *)pin, n);
		}
		else if(line[0] == 'i')
			chiaki_session_request_idr(&session);
		else if(line[0] == 's')
		{
			chiaki_session_goto_bed(&session);
			SLEEP_MS(300);
			break;
		}
		else if(line[0] == 'q')
			break;
	}
	chiaki_session_stop(&session);
	chiaki_session_join(&session);
	chiaki_session_fini(&session);
	emit_event("{\"ev\":\"closed\"}");
	return 0;
}

int main(int argc, char **argv)
{
#ifdef _WIN32
	_setmode(_fileno(stdout), _O_BINARY);
#endif
	if(chiaki_lib_init() != CHIAKI_ERR_SUCCESS)
	{
		fprintf(stderr, "chiaki_lib_init failed\n");
		return 1;
	}
	chiaki_mutex_init(&out_mutex, false);
	if(argc >= 2 && strcmp(argv[1], "regist") == 0)
		return cmd_regist(argc, argv);
	if(argc >= 2 && strcmp(argv[1], "stream") == 0)
		return cmd_stream(argc, argv);
	if(argc >= 2 && strcmp(argv[1], "version") == 0)
	{
		printf("{\"ok\":true,\"app\":\"hongsub-rp\",\"chiaki\":\"%s\"}\n", CHIAKI_VERSION);
		return 0;
	}
	fprintf(stderr, "usage: hongsub-rp regist|stream|version ...\n");
	return 2;
}
