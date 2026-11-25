package store.honggame.hongsub;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The phone's own Vietnamese voices (Android text-to-speech, usually "Dịch vụ lời nói của Google").
 * The page lists them next to the Google online voice; one line at a time, a waiting line is read a little faster.
 */
final class Voice {
    private static TextToSpeech tts;
    private static volatile boolean ready = false;
    private static final List<android.speech.tts.Voice> vi = new ArrayList<>();
    private static int seq = 0;

    static synchronized void init(Context c) {
        if (tts != null) return;
        tts = new TextToSpeech(c.getApplicationContext(), st -> {
            if (st != TextToSpeech.SUCCESS) return;
            try { tts.setLanguage(new Locale("vi", "VN")); } catch (Exception ignored) { }
            try {
                Set<android.speech.tts.Voice> all = tts.getVoices();
                if (all != null) for (android.speech.tts.Voice v : all)
                    if (v.getLocale() != null && "vi".equals(v.getLocale().getLanguage()) && !v.isNetworkConnectionRequired()) vi.add(v);
                if (all != null && vi.isEmpty()) for (android.speech.tts.Voice v : all)
                    if (v.getLocale() != null && "vi".equals(v.getLocale().getLanguage())) vi.add(v);
            } catch (Exception ignored) { }
            ready = true;
        });
    }

    /** "Điện thoại 1", "Điện thoại 2"... (Android names voices like vi-vn-x-gft-local, which mean nothing to a player) */
    static String list() {
        JSONArray a = new JSONArray();
        try {
            for (int i = 0; i < vi.size(); i++) {
                android.speech.tts.Voice v = vi.get(i);
                String n = v.getName().toLowerCase(Locale.ROOT);
                String g = n.contains("male") && !n.contains("female") ? " (nam)" : n.contains("female") ? " (nữ)" : "";
                a.put(new JSONObject().put("name", "Giọng điện thoại " + (i + 1) + g + " · " + v.getName()).put("lang", "vi-VN"));
            }
        } catch (Exception ignored) { }
        return a.toString();
    }

    private static long lastAt = 0;

    static void speak(String text, String name, float rate, float pitch, boolean queue) {
        if (tts == null || !ready || text == null || text.trim().isEmpty()) return;
        try {
            for (android.speech.tts.Voice v : vi) if (name != null && name.endsWith(v.getName())) { tts.setVoice(v); break; }
            tts.setSpeechRate(Math.max(0.5f, Math.min(3f, rate)));
            tts.setPitch(Math.max(0.5f, Math.min(2f, pitch)));
            Bundle b = new Bundle();
            b.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
            /* the voice follows the character: a new subtitle line replaces what is still waiting or being read for long */
            long now = android.os.SystemClock.elapsedRealtime();
            boolean busy = tts.isSpeaking();
            boolean flush = !queue || (busy && now - lastAt > 2500);
            if (flush || !busy) lastAt = now;
            tts.speak(text, flush ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, b, "hs" + (++seq));
        } catch (Exception ignored) { }
    }

    static void stop() { try { if (tts != null) tts.stop(); } catch (Exception ignored) { } }
}
