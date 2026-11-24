package store.honggame.hongsub;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps the Hóng Sub phone app (the copy from honggame.store) up to date by itself: looks at the newest release on
 * GitHub, downloads hong-sub-android.apk and hands it to Android's installer. On Android 12+ later updates go through
 * without a press once this app installed itself; otherwise Android shows one "Cập nhật" button. Each step is told to
 * the page (Hỗ trợ › Phiên bản), which also has a "Kiểm tra cập nhật" button.
 */
final class Updater {
    static final String STORE = "site";
    static final String API = "https://api.github.com/repos/nvhnhi96-ui/hong-sub-tv/releases/latest";
    static final String ASSET = "hong-sub-android.apk";

    interface Listener { void onState(String text, boolean busy); }

    private static volatile boolean running = false;
    private static long lastCheck = 0;
    /* the last step, for the page when it opens after the check began: {"t":..,"busy":..} */
    static volatile String last = "";
    static String state() { return last; }

    /** "1.0.78" -> 78 (the build number), 0 if it cannot be read */
    static int build(String v) {
        if (v == null) return 0;
        String[] p = v.replaceAll("^[vV]", "").trim().split("\\.");
        try { return Integer.parseInt(p[p.length - 1].replaceAll("[^0-9]", "")); } catch (Exception e) { return 0; }
    }

    static String current(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return pi.versionName == null ? "" : pi.versionName;
        } catch (Exception e) { return ""; }
    }

    /** true when Android lets this app update itself without asking (Android 12+, last installed by this app) */
    static boolean silentPossible(Context c) {
        if (Build.VERSION.SDK_INT < 31) return false;
        try {
            String by = c.getPackageManager().getInstallSourceInfo(c.getPackageName()).getInstallingPackageName();
            return c.getPackageName().equals(by);
        } catch (Exception e) { return false; }
    }

    /**
     * Look for a newer build and install it.
     * @param userHere the app screen is open, so Android may ask the person to confirm
     * @param minGapMs skip if the last look was more recent than this
     */
    static void check(Context ctx, boolean userHere, long minGapMs, Listener ui) {
        final Context c = ctx.getApplicationContext();
        final Handler main = new Handler(Looper.getMainLooper());
        final Listener say = (t, b) -> {
            try { last = new JSONObject().put("t", t).put("busy", b).toString(); } catch (Exception ignored) { }
            if (ui != null) main.post(() -> ui.onState(t, b)); };
        if (running) return;
        if (System.currentTimeMillis() - lastCheck < minGapMs) return;
        running = true; lastCheck = System.currentTimeMillis();
        new Thread(() -> {
            try {
                final String cur = current(c);
                say.onState("Bản " + cur + " · đang xem có bản mới không...", true);
                JSONObject rel = new JSONObject(get(API));
                String tag = rel.optString("tag_name", "");
                String url = "";
                long size = 0;
                JSONArray as = rel.optJSONArray("assets");
                for (int i = 0; as != null && i < as.length(); i++) {
                    JSONObject a = as.getJSONObject(i);
                    if (ASSET.equals(a.optString("name"))) { url = a.optString("browser_download_url"); size = a.optLong("size"); }
                }
                if (url.isEmpty() || build(tag) <= build(cur)) { say.onState("Bản " + cur + " · đã là bản mới nhất", false); return; }
                String nv = tag.replaceAll("^[vV]", "");
                if (!userHere && !silentPossible(c)) {
                    // the game is on: do not throw a dialog over it, ask next time the app is opened
                    c.getSharedPreferences("hongsub", Context.MODE_PRIVATE).edit().putString("updWaiting", nv).apply();
                    say.onState("Có bản " + nv + ". Mở app Hóng Sub để cập nhật.", false);
                    return;
                }
                say.onState("Đang tải bản " + nv + "...", true);
                install(c, url, size, nv, say);
            } catch (Exception e) {
                say.onState("Chưa kiểm tra được bản mới (mạng?)", false);
            } finally {
                running = false;
            }
        }, "hongsub-update").start();
    }

    private static void install(Context c, String url, long size, String nv, Listener say) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(c.getPackageName());
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        if (size > 0) params.setSize(size);
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            HttpURLConnection h = open(url);
            long total = size > 0 ? size : h.getContentLengthLong(), done = 0;
            int lastPct = -1;
            try (InputStream in = h.getInputStream(); OutputStream out = s.openWrite("hongsub", 0, total > 0 ? total : -1)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n); done += n;
                    if (total > 0) { int pct = (int) (done * 100 / total); if (pct / 10 != lastPct / 10) { lastPct = pct; say.onState("Đang tải bản " + nv + "... " + pct + "%", true); } }
                }
                s.fsync(out);
            } finally { h.disconnect(); }
            Intent done2 = new Intent(c, UpdateReceiver.class).setAction(UpdateReceiver.ACTION);
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pend = PendingIntent.getBroadcast(c, id, done2, fl);
            say.onState("Đang cài bản " + nv + ". Android hỏi thì bấm Cập nhật (lần đầu có thể phải cho phép Hóng Sub cài ứng dụng).", true);
            s.commit(pend.getIntentSender());
        } catch (Exception e) {
            try { pi.abandonSession(id); } catch (Exception ignored) { }
            throw e;
        }
        c.getSharedPreferences("hongsub", Context.MODE_PRIVATE).edit().remove("updWaiting").apply();
    }

    private static HttpURLConnection open(String url) throws Exception {
        for (int hop = 0; hop < 5; hop++) {   // GitHub sends the file from another address
            HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
            h.setInstanceFollowRedirects(false);
            h.setConnectTimeout(15000); h.setReadTimeout(30000);
            h.setRequestProperty("User-Agent", "HongSubPhone");
            int code = h.getResponseCode();
            if (code >= 300 && code < 400 && h.getHeaderField("Location") != null) { url = h.getHeaderField("Location"); h.disconnect(); continue; }
            if (code != 200) { h.disconnect(); throw new Exception("HTTP " + code); }
            return h;
        }
        throw new Exception("too many redirects");
    }

    private static String get(String url) throws Exception {
        HttpURLConnection h = open(url);
        try (InputStream in = h.getInputStream()) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString("UTF-8");
        } finally { h.disconnect(); }
    }
}
