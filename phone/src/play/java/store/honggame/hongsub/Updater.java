package store.honggame.hongsub;

import android.content.Context;
import android.content.pm.PackageInfo;

/** Google Play copy: Google Play keeps the app up to date, so there is nothing to do here. */
final class Updater {
    interface Listener { void onState(String text, boolean busy); }
    static final String STORE = "play";

    static String current(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return pi.versionName == null ? "" : pi.versionName;
        } catch (Exception e) { return ""; }
    }

    static void check(Context ctx, boolean userHere, long minGapMs, Listener ui) { }
    static String state() { return ""; }
}
