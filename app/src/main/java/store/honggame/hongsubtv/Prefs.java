package store.honggame.hongsubtv;

import android.content.Context;
import android.content.SharedPreferences;

import java.security.SecureRandom;

/** Small wrapper around SharedPreferences for the pairing code and display settings. */
final class Prefs {
    static final String RELAY = "https://honggame.store/wp-json/hgs-sub/v1/pull?room=";
    private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    private final SharedPreferences sp;

    Prefs(Context c) {
        sp = c.getSharedPreferences("hongsub", Context.MODE_PRIVATE);
    }

    String code() {
        String c = sp.getString("code", null);
        if (c == null) {
            c = newCode();
        }
        return c;
    }

    String newCode() {
        SecureRandom r = new SecureRandom();
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 6; i++) {
            b.append(ALPHABET.charAt(r.nextInt(ALPHABET.length())));
        }
        String c = b.toString();
        sp.edit().putString("code", c).apply();
        return c;
    }

    int textSize() { return sp.getInt("size", 30); }
    void textSize(int v) { sp.edit().putInt("size", Math.max(18, Math.min(60, v))).apply(); }

    boolean top() { return sp.getBoolean("top", false); }
    void top(boolean v) { sp.edit().putBoolean("top", v).apply(); }

    boolean speak() { return sp.getBoolean("speak", true); }
    void speak(boolean v) { sp.edit().putBoolean("speak", v).apply(); }

    boolean showEn() { return sp.getBoolean("en", false); }
    void showEn(boolean v) { sp.edit().putBoolean("en", v).apply(); }

    boolean running() { return sp.getBoolean("running", false); }
    void running(boolean v) { sp.edit().putBoolean("running", v).apply(); }
}
