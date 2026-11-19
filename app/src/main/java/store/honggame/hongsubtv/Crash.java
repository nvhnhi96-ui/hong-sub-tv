package store.honggame.hongsubtv;

import android.content.Context;
import android.content.SharedPreferences;

/** a crash of the TV app is kept, then sent to Hóng Sub on the computer (it shows in "Báo lỗi") */
final class Crash {
    private Crash() { }
    private static volatile boolean set;

    static void install(Context c) {
        if (set) return; set = true;
        final Context ac = c.getApplicationContext();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            note(ac, e);
            if (prev != null) prev.uncaughtException(t, e);
        });
    }

    static void note(Context c, Throwable e) {
        try {
            java.io.StringWriter w = new java.io.StringWriter();
            e.printStackTrace(new java.io.PrintWriter(w));
            String s = w.toString();
            if (s.length() > 1500) s = s.substring(0, 1500);
            sp(c).edit().putString("crash", Updater.current(c) + " " + s).commit();
        } catch (Throwable ignored) { }
    }

    /** the last crash, once (then forgotten) */
    static String take(Context c) {
        try {
            SharedPreferences p = sp(c);
            String s = p.getString("crash", "");
            if (!s.isEmpty()) p.edit().remove("crash").apply();
            return s;
        } catch (Throwable e) { return ""; }
    }

    private static SharedPreferences sp(Context c) { return c.getSharedPreferences("hongsub_crash", Context.MODE_PRIVATE); }
}
