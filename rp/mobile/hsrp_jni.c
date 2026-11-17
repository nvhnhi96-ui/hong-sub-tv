/* SPDX-License-Identifier: AGPL-3.0-only
 * Android entry point of the Hóng Sub phone core: store.honggame.hongsub.Hsrp.start(port, token, webRoot) */
#include "hsrp.h"
#include <jni.h>
#ifdef __ANDROID__
#include <android/log.h>
static void lg(const char *l) { __android_log_print(ANDROID_LOG_INFO, "HongSubRP", "%s", l); }
#else
static void lg(const char *l) { (void)l; }
#endif

JNIEXPORT jint JNICALL Java_store_honggame_hongsub_Hsrp_start(JNIEnv *env, jclass cls, jint port, jstring token, jstring root)
{
	(void)cls;
	const char *t = token ? (*env)->GetStringUTFChars(env, token, NULL) : NULL;
	const char *r = root ? (*env)->GetStringUTFChars(env, root, NULL) : NULL;
	hsrp_set_log(lg);
	int p = hsrp_start((int)port, t ? t : "", r ? r : "");
	if(t) (*env)->ReleaseStringUTFChars(env, token, t);
	if(r) (*env)->ReleaseStringUTFChars(env, root, r);
	return p;
}
