package store.honggame.hongsub;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.List;

/** Settings shared by the setup screen and the capture service. */
final class Prefs {
    private final SharedPreferences sp;

    Prefs(Context c) {
        sp = c.getSharedPreferences("hongsub", Context.MODE_PRIVATE);
    }

    String keysRaw() { return sp.getString("keys", ""); }
    void keysRaw(String v) { sp.edit().putString("keys", v == null ? "" : v.trim()).apply(); }

    List<String> keys() {
        List<String> out = new ArrayList<>();
        for (String s : keysRaw().split("[\\s,]+")) {
            if (s.trim().length() > 20) out.add(s.trim());
        }
        return out;
    }

    String groqRaw() { return sp.getString("groq", ""); }
    void groqRaw(String v) { sp.edit().putString("groq", v == null ? "" : v.trim()).apply(); }

    List<String> groqKeys() {
        List<String> out = new ArrayList<>();
        for (String s : groqRaw().split("[\\s,]+")) {
            if (s.trim().length() > 20) out.add(s.trim());
        }
        return out;
    }

    List<String> groqModels() {
        List<String> out = new ArrayList<>();
        for (String s : sp.getString("gmodels", "").split("\n")) {
            if (!s.trim().isEmpty()) out.add(s.trim());
        }
        if (out.isEmpty()) out.addAll(Groq.PREF);
        return out;
    }
    void groqModels(List<String> m) { sp.edit().putString("gmodels", android.text.TextUtils.join("\n", m)).apply(); }

    /** Ranked model names, newline separated (fastest first). */
    List<String> models() {
        List<String> out = new ArrayList<>();
        for (String s : sp.getString("models", "").split("\n")) {
            if (!s.trim().isEmpty()) out.add(s.trim());
        }
        if (out.isEmpty()) {
            out.add("gemini-flash-lite-latest");
            out.add("gemini-flash-latest");
            out.add("gemini-2.5-flash-lite");
            out.add("gemini-2.5-flash");
        }
        return out;
    }
    void models(List<String> m) { sp.edit().putString("models", android.text.TextUtils.join("\n", m)).apply(); }

    String tv() { return sp.getString("tv", ""); }
    void tv(String v) { sp.edit().putString("tv", v == null ? "" : v.toUpperCase().replaceAll("[^A-Z0-9]", "")).apply(); }

    String game() { return sp.getString("game", ""); }
    void game(String v) { sp.edit().putString("game", v == null ? "" : v.trim()).apply(); }

    String gameNotes(String game) { return sp.getString("gn_" + key(game), ""); }
    void gameNotes(String game, String v) { if (key(game).isEmpty()) return; sp.edit().putString("gn_" + key(game), v == null ? "" : v.trim()).apply(); }
    static String key(String g) { return g == null ? "" : g.trim().toLowerCase(java.util.Locale.ROOT); }

    String presetsJson() { return sp.getString("presets_json", ""); }
    void presetsJson(String v) { sp.edit().putString("presets_json", v).apply(); }

    String notes() { return sp.getString("notes", ""); }
    void notes(String v) { sp.edit().putString("notes", v == null ? "" : v.trim()).apply(); }

    boolean speak() { return sp.getBoolean("speak", true); }
    void speak(boolean v) { sp.edit().putBoolean("speak", v).apply(); }

    boolean showEn() { return sp.getBoolean("en", true); }
    void showEn(boolean v) { sp.edit().putBoolean("en", v).apply(); }

    int interval() { return sp.getInt("interval", 700); }
    void interval(int v) { sp.edit().putInt("interval", v).apply(); }

    /** Subtitle region as fractions of the screen: x, y, w, h. */
    float[] region() {
        return new float[]{
                sp.getFloat("rx", 0.10f), sp.getFloat("ry", 0.76f),
                sp.getFloat("rw", 0.80f), sp.getFloat("rh", 0.18f)};
    }
    void region(float x, float y, float w, float h) {
        sp.edit().putFloat("rx", x).putFloat("ry", y).putFloat("rw", w).putFloat("rh", h).apply();
    }
}
