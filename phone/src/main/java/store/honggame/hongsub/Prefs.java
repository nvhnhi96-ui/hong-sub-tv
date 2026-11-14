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

    String orRaw() { return sp.getString("or", ""); }
    void orRaw(String v) { sp.edit().putString("or", v == null ? "" : v.trim()).apply(); }
    List<String> orKeys() {
        List<String> out = new ArrayList<>();
        for (String s : orRaw().split("[\\s,]+")) if (s.trim().length() > 20) out.add(s.trim());
        return out;
    }
    List<String> orModels() {
        List<String> out = new ArrayList<>();
        for (String s : sp.getString("ormodels", "").split("\n")) if (!s.trim().isEmpty()) out.add(s.trim());
        return out;
    }
    void orModels(List<String> m) { sp.edit().putString("ormodels", android.text.TextUtils.join("\n", m)).apply(); }
    boolean orPaid() { return sp.getBoolean("orpaid", false); }
    void orPaid(boolean v) { sp.edit().putBoolean("orpaid", v).apply(); }
    long orListed() { return sp.getLong("orlisted", 0); }
    void orListed(long v) { sp.edit().putLong("orlisted", v).apply(); }

    /** when several AIs answer: "fast", "balanced" (wait 0.6s for the smart AI) or "best" */
    String prefer() { return sp.getString("prefer", "balanced"); }
    void prefer(String v) { sp.edit().putString("prefer", v).apply(); }

    /** extra areas (quests, items), JSON array of {x,y,w,h} fractions */
    String zones() { return sp.getString("zones", "[]"); }
    void zones(String v) { sp.edit().putString("zones", v).apply(); }

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

    int interval() { int v = sp.getInt("interval", 400); return v == 700 ? 400 : v; }
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
