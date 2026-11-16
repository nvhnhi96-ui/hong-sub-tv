package store.honggame.hongsubtv;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.util.concurrent.atomic.AtomicInteger;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.util.DisplayMetrics;
import java.util.HashMap;
import java.util.ArrayDeque;
import org.json.JSONArray;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Foreground service that draws a subtitle bar over whatever is on screen (game on HDMI input)
 * and polls the Hong Game Store relay for the newest translated line for this TV's code.
 */
public class OverlayService extends Service {
    static final String ACTION_REFRESH = "refresh";
    static final String ACTION_STOP = "stop";
    private static final String CHANNEL = "hongsub";
    private static final long POLL_MS = 450;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private LinearLayout box;
    private TextView viView;
    private TextView enView;
    private WindowManager.LayoutParams lp;
    /* translations of the extra areas (quests, items...), drawn at the same place as on the computer */
    private FrameLayout zoneLayer;
    private final HashMap<String, TextView> zoneViews = new HashMap<>();
    private final HashMap<String, Runnable> zoneOff = new HashMap<>();
    /* a line that arrives two ways is shown once */
    private final ArrayDeque<String> mids = new ArrayDeque<>();
    private Prefs prefs;
    private volatile boolean polling;
    private Thread poller;
    private TextToSpeech tts;
    private boolean ttsReady;
    /* lines waiting to be read: a new line waits for the one being read, unless two are already waiting */
    private final AtomicInteger ttsPending = new AtomicInteger();

    /* lines read by the voice chosen on the computer: the computer makes the sound and sends it, the TV plays it */
    private final ArrayDeque<Object[]> clips = new ArrayDeque<>();   // {File, Float rate}
    private MediaPlayer clipPlayer = null;
    private int clipSeq = 0;

    private void clipAdd(String b64, String mime, float rate) {
        try {
            byte[] data = Base64.decode(b64, Base64.DEFAULT);
            if (data.length < 200) return;
            File f = new File(getCacheDir(), "clip" + (++clipSeq % 8) + (mime != null && mime.contains("mpeg") ? ".mp3" : ".wav"));
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(data); }
            main.post(() -> {
                if (clips.size() >= 2) clips.pollFirst();   // far behind: drop the oldest waiting line
                clips.add(new Object[]{f, clipPlayer != null || !clips.isEmpty() ? rate * 1.12f : rate});
                if (clipPlayer == null) clipNext();
            });
        } catch (Exception ignored) { }
    }

    private void clipNext() {
        Object[] it = clips.pollFirst();
        if (it == null) return;
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            mp.setDataSource(((File) it[0]).getAbsolutePath());
            mp.setOnCompletionListener(x -> { x.release(); if (clipPlayer == x) clipPlayer = null; clipNext(); });
            mp.setOnErrorListener((x, a, b) -> { x.release(); if (clipPlayer == x) clipPlayer = null; clipNext(); return true; });
            mp.prepare();
            float r = (Float) it[1];
            if (Math.abs(r - 1f) > 0.01f) { try { mp.setPlaybackParams(new PlaybackParams().setSpeed(r)); } catch (Exception ignored) { } }
            clipPlayer = mp;
            mp.start();
        } catch (Exception e) { clipPlayer = null; main.post(this::clipNext); }
    }

    private void clipStop() {
        main.post(() -> {
            clips.clear();
            if (clipPlayer != null) { try { clipPlayer.stop(); } catch (Exception ignored) { } try { clipPlayer.release(); } catch (Exception ignored) { } clipPlayer = null; }
        });
    }
    private int ttsSeq;
    private void ttsDone() { if (ttsPending.decrementAndGet() < 0) ttsPending.set(0); }
    private LanServer lan;
    private final Runnable hideRunnable = () -> { if (box != null) box.setVisibility(View.GONE); };

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = new Prefs(this);
        startAsForeground();
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            prefs.running(false);
            stopSelf();
            return;
        }
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        buildOverlay();
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(new Locale("vi", "VN"));
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { ttsDone(); }
                    @Override public void onError(String id) { ttsDone(); }
                    @Override public void onStop(String id, boolean interrupted) { ttsDone(); }
                });
            }
        });
        startPolling();
        lan = new LanServer(this, prefs, this::handle);
        lan.start();
        String ip = LanServer.ip();
        showLine("", "Hóng Sub TV đang chờ phụ đề · Mã " + prefs.code() + (ip.isEmpty() ? "" : " · IP " + ip), null, 8000, false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(a)) {
            prefs.running(false);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_REFRESH.equals(a)) {
            applyStyle();
            showLine("", "Cỡ chữ và vị trí phụ đề như thế này", null, 3000, false);
        }
        prefs.running(true);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        polling = false;
        main.removeCallbacks(updLook);
        clipStop();
        if (lan != null) lan.stop();
        if (poller != null) poller.interrupt();
        main.removeCallbacksAndMessages(null);
        if (box != null && wm != null) {
            try { wm.removeView(box); } catch (Exception ignored) { }
        }
        if (zoneLayer != null && wm != null) {
            try { wm.removeView(zoneLayer); } catch (Exception ignored) { }
        }
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    private void startAsForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Hóng Sub", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        Intent open = new Intent(this, MainActivity.class);
        int piFlags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);
        Notification n = b.setContentTitle("Hóng Sub TV")
                .setContentText("Đang hiện phụ đề tiếng Việt")
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(1, n);
        }
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private void buildOverlay() {
        box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(22), dp(10), dp(22), dp(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(205, 8, 8, 10));
        bg.setCornerRadius(dp(10));
        box.setBackground(bg);

        viView = new TextView(this);
        viView.setTextColor(Color.WHITE);
        viView.setTypeface(Typeface.DEFAULT_BOLD);
        viView.setGravity(Gravity.CENTER);
        viView.setShadowLayer(4f, 0f, 1f, Color.BLACK);
        box.addView(viView);

        enView = new TextView(this);
        enView.setTextColor(Color.rgb(180, 180, 190));
        enView.setGravity(Gravity.CENTER);
        box.addView(enView);

        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                PixelFormat.TRANSLUCENT);
        applyStyle();
        box.setVisibility(View.GONE);
        zoneLayer = new FrameLayout(this);
        WindowManager.LayoutParams zlp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        zlp.gravity = Gravity.TOP | Gravity.START;
        try { wm.addView(zoneLayer, zlp); } catch (Exception e) { zoneLayer = null; }
        wm.addView(box, lp);
    }

    private void zoneShow(JSONObject j, String vi) {
        final String id = j.optString("zid", "");
        if (id.isEmpty()) return;
        final double x = j.optDouble("x", 0), y = j.optDouble("y", 0), w = Math.max(0.06, j.optDouble("w", 0.3)), h = Math.max(0.04, j.optDouble("h", 0.15));
        final int hold = j.optInt("hold", 0);
        final String zs = j.optString("zs", "m");
        final int zbg = j.has("zbg") ? Math.max(0, Math.min(100, j.optInt("zbg", 90))) : 90;
        final Typeface face = faceFor(j.optString("font", prefs.font()));
        main.post(() -> {
            if (zoneLayer == null) return;
            Runnable old = zoneOff.remove(id);
            if (old != null) main.removeCallbacks(old);
            TextView tv = zoneViews.get(id);
            if (vi.isEmpty()) { if (tv != null) { zoneLayer.removeView(tv); zoneViews.remove(id); } return; }
            if (tv == null) {
                tv = new TextView(this);
                tv.setTextColor(Color.WHITE);
                tv.setTypeface(Typeface.DEFAULT_BOLD);
                tv.setShadowLayer(3f, 0f, 1f, Color.BLACK);
                tv.setPadding(dp(8), dp(5), dp(8), dp(5));
                GradientDrawable bg = new GradientDrawable();
                bg.setColor(Color.argb(230, 8, 9, 12));
                bg.setCornerRadius(dp(5));
                tv.setBackground(bg);
                zoneViews.put(id, tv);
                zoneLayer.addView(tv);
            }
            DisplayMetrics dm = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            int W = dm.widthPixels, H = dm.heightPixels, bw = (int) (w * W), bh = (int) (h * H);
            FrameLayout.LayoutParams fl = new FrameLayout.LayoutParams(bw, bh);
            fl.leftMargin = (int) (x * W);
            fl.topMargin = (int) (y * H);
            tv.setLayoutParams(fl);
            tv.setText(vi);
            GradientDrawable zb = new GradientDrawable();
            zb.setColor(Color.argb(Math.round(zbg * 2.55f), 8, 9, 12));
            zb.setCornerRadius(dp(5));
            tv.setBackground(zb);
            tv.setTypeface(face);
            // as big as the area allows, smaller for long text
            float cap = (zs.equals("xs") ? 20 : zs.equals("s") ? 26 : zs.equals("l") ? 44 : zs.equals("xl") ? 56 : 34) * (H / 1080f);
            int lines = vi.split("\n").length;
            float fit = Math.max(12f, Math.min(cap, bh / (float) lines * 0.62f));
            if (Build.VERSION.SDK_INT >= 26) {
                tv.setAutoSizeTextTypeUniformWithConfiguration(10, Math.max(11, (int) fit), 1, TypedValue.COMPLEX_UNIT_PX);
            } else {
                tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, fit);
            }
            final TextView view = tv;
            Runnable off = () -> { zoneLayer.removeView(view); zoneViews.remove(id); zoneOff.remove(id); };
            zoneOff.put(id, off);
            main.postDelayed(off, hold > 0 ? hold * 1000L : 300000L);
        });
    }

    /** The typeface picked on the computer, as close as Android TV's own fonts allow. */
    private static Typeface faceFor(String k) {
        String fam = "sans-serif";
        if ("notoserif".equals(k)) fam = "serif";
        else if ("oswald".equals(k)) fam = "sans-serif-condensed";
        else if ("quicksand".equals(k) || "nunito".equals(k)) fam = "sans-serif-medium";
        return Typeface.create(fam, Typeface.BOLD);
    }

    private double[] cov = null;   // the original subtitle's place (x, y, w, h as parts of the screen), or null

    private void applyStyle() {
        if (box == null) return;
        int size = prefs.textSize();
        viView.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        enView.setTextSize(TypedValue.COMPLEX_UNIT_SP, Math.max(14, size * 0.55f));
        int screenW = getResources().getDisplayMetrics().widthPixels;
        float w = prefs.width() / 100f;
        viView.setMaxWidth((int) (screenW * w));
        enView.setMaxWidth((int) (screenW * w));
        int col = Color.WHITE;
        try { col = Color.parseColor(prefs.color()); } catch (Exception ignored) { }
        viView.setTextColor(col);
        viView.setTypeface(faceFor(prefs.font()));
        GradientDrawable bgd = new GradientDrawable();
        bgd.setColor(Color.argb(Math.round(prefs.bg() * 2.55f), 8, 8, 10));
        bgd.setCornerRadius(dp(10));
        box.setBackground(bgd);
        if (cov != null) {
            // "Đè chữ Việt lên đúng chỗ phụ đề gốc": the box takes the original subtitle's place on the picture
            DisplayMetrics dm = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            lp.gravity = Gravity.TOP | Gravity.LEFT;
            lp.x = (int) (cov[0] * dm.widthPixels); lp.y = (int) (cov[1] * dm.heightPixels);
            lp.width = (int) (cov[2] * dm.widthPixels); lp.height = Math.max(dp(30), (int) (cov[3] * dm.heightPixels));
            viView.setMaxWidth(lp.width);
            GradientDrawable cb = new GradientDrawable();
            cb.setColor(Color.argb(Math.max(225, Math.round(prefs.bg() * 2.55f)), 8, 8, 10));
            cb.setCornerRadius(dp(4));
            box.setBackground(cb);
            box.setGravity(Gravity.CENTER);
        } else {
            lp.width = WindowManager.LayoutParams.WRAP_CONTENT; lp.height = WindowManager.LayoutParams.WRAP_CONTENT; lp.x = 0; box.setGravity(Gravity.CENTER_HORIZONTAL);
            lp.gravity = (prefs.top() ? Gravity.TOP : Gravity.BOTTOM) | Gravity.CENTER_HORIZONTAL;
            lp.y = dp(prefs.top() ? 36 : 46);
        }
        try { wm.updateViewLayout(box, lp); } catch (Exception ignored) { }
    }

    private void showLine(String who, String vi, String en, long holdMs, boolean speakIt) {
        main.post(() -> {
            if (box == null) return;
            SpannableStringBuilder sb = new SpannableStringBuilder();
            if (who != null && !who.isEmpty()) {
                sb.append(who).append(": ");
                sb.setSpan(new ForegroundColorSpan(Color.rgb(255, 196, 0)), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            sb.append(vi);
            viView.setText(sb);
            boolean en1 = prefs.showEn() && en != null && !en.isEmpty();
            enView.setText(en1 ? en : "");
            enView.setVisibility(en1 ? View.VISIBLE : View.GONE);
            box.setVisibility(View.VISIBLE);
            main.removeCallbacks(hideRunnable);
            main.postDelayed(hideRunnable, holdMs);
            if (speakIt && ttsReady) {
                boolean behind = ttsPending.get() >= 3;
                if (behind) ttsPending.set(0);
                ttsPending.incrementAndGet();
                tts.speak(vi, behind ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, null, "line" + (++ttsSeq));
            }
        });
    }

    /** one message from the computer (through honggame.store or straight over the home network) */
    void handle(JSONObject j) {
        String mid = j.optString("mid", "");
        if (!mid.isEmpty()) {
            synchronized (mids) {
                if (mids.contains(mid)) return;
                mids.add(mid);
                if (mids.size() > 60) mids.poll();
            }
        }
        String vi = j.optString("vi", "");
        // text size and position chosen on the computer
        int size = j.optInt("size", 0);
        String pos = j.optString("pos", "");
        boolean changed = false;
        if (size >= 18 && size != prefs.textSize()) { prefs.textSize(size); changed = true; }
        if (j.has("sen") && j.optBoolean("sen", false) != prefs.showEn()) { prefs.showEn(j.optBoolean("sen", false)); }   // English line: set on the computer
        if (j.has("cov")) {
            JSONObject c = j.optJSONObject("cov");
            double[] nc = c != null && c.optDouble("w", 0) > 0.02 && c.optDouble("h", 0) > 0.02
                    ? new double[]{c.optDouble("x", 0), c.optDouble("y", 0), c.optDouble("w", 0), c.optDouble("h", 0)} : null;
            if (!java.util.Arrays.equals(nc, cov)) { cov = nc; changed = true; }
        }
        int pb = Updater.build(j.optString("appv", ""));
        if (pb > pcBuild) {
            pcBuild = pb;
            if (pb > Updater.build(Updater.current(this))) {
                Updater.check(this, false, 30 * 60 * 1000L, (t, busy) -> { if (!busy && t.startsWith("Có bản")) showLine("Hóng Sub", t, "", 8000, false); });
            }
        }
        String fk = j.optString("font", "");
        if (fk.matches("[a-z]{2,12}") && !fk.equals(prefs.font())) { prefs.font(fk); changed = true; }
        String col = j.optString("col", "");
        if (col.matches("#[0-9A-Fa-f]{6}") && !col.equalsIgnoreCase(prefs.color())) { prefs.color(col); changed = true; }
        if (j.has("bg")) { int b = j.optInt("bg", -1); if (b >= 0 && b <= 100 && b != prefs.bg()) { prefs.bg(b); changed = true; } }
        if (j.has("wid")) { int w = j.optInt("wid", 0); if (w >= 40 && w <= 100 && w != prefs.width()) { prefs.width(w); changed = true; } }
        if (pos.equals("top") && !prefs.top()) { prefs.top(true); changed = true; }
        if (pos.equals("bottom") && prefs.top()) { prefs.top(false); changed = true; }
        if (changed) main.post(this::applyStyle);
        String kind = j.optString("kind", "sub");
        // Hóng Sub on the computer says whether the TV reads aloud (off, or read on the computer instead)
        // "Đọc phụ đề" turned off on the computer (rd:false) always wins
        boolean pcOff = j.has("rd") && !j.optBoolean("rd", true);
        boolean read = !pcOff && (j.has("speak") ? j.optBoolean("speak", false) : prefs.speak());
        // an area translation or a notice never cuts the line being read; only a subtitle or a setting change does
        boolean stops = pcOff || (j.has("speak") && !read && (kind.equals("sub") || kind.equals("ctl")));
        if (stops && tts != null) { tts.stop(); ttsPending.set(0); }
        if (pcOff) clipStop();
        if (kind.equals("say")) {   // only the sound of a line, in the voice chosen on the computer
            if (!pcOff) clipAdd(j.optString("aud", ""), j.optString("mime", "audio/wav"), (float) Math.max(0.5, Math.min(2.5, j.optDouble("rate", 1))));
            return;
        }
        if (kind.equals("hello") || kind.equals("ctl") || kind.equals("alive")) { /* nothing to show */ }
        else if (kind.equals("zone")) {
            zoneShow(j, vi);   // read aloud only when the area asks for it on the computer
            if (!vi.isEmpty() && read && ttsReady) { ttsPending.incrementAndGet(); tts.speak(vi.replace("\n", ". "), TextToSpeech.QUEUE_ADD, null, "zone" + (++ttsSeq)); }
        }
        else if (kind.equals("notice")) {
            // a message from Hóng Sub on the computer (app opened, PS5 waking...): shown, not read aloud
            if (!vi.isEmpty()) showLine(j.optString("who", "Hóng Sub"), vi, "", 6000, false);
        }
        else if (!vi.isEmpty()) {
            long hold = Math.max(4500, Math.min(12000, vi.length() * 110L));
            showLine(j.optString("who", ""), vi, j.optString("en", ""), hold, read);
        }
    }

    /** tells the computer that this TV is on: Hóng Sub on the computer then wakes the PS5 and answers */
    private void hello() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(Prefs.RELAY.replace("pull?room=", "push")).openConnection();
            c.setConnectTimeout(5000); c.setReadTimeout(5000); c.setDoOutput(true); c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            String body = new JSONObject().put("room", prefs.code() + "T").put("kind", "hello").put("vi", "tv").toString();
            try (java.io.OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
            c.getResponseCode(); c.disconnect();
        } catch (Exception ignored) { }
    }

    /* new builds: a look every 6 hours, and right away when the computer runs a newer Hóng Sub than this TV app */
    private final Runnable updLook = new Runnable() {
        @Override public void run() {
            Updater.check(OverlayService.this, false, 60 * 60 * 1000L, null);
            main.postDelayed(this, 6 * 60 * 60 * 1000L);
        }
    };
    private int pcBuild = 0;

    private void startPolling() {
        main.removeCallbacks(updLook);
        main.postDelayed(updLook, 90 * 1000L);
        polling = true;
        poller = new Thread(() -> {
            hello();
            long lastSeq = -1;
            while (polling) {
                long wait = POLL_MS;
                try {
                    JSONObject j = fetch(Prefs.RELAY + prefs.code() + (lastSeq >= 0 ? "&since=" + lastSeq : "") + "&t=" + System.currentTimeMillis());
                    long seq = j.optLong("seq", 0);
                    if (lastSeq < 0) {
                        lastSeq = seq; // ignore whatever was there before this TV started listening
                    } else if (seq != lastSeq) {
                        // newer servers list every message after the last one seen: a subtitle and an area sent together both show
                        JSONArray items = j.optJSONArray("items");
                        if (items != null && items.length() > 0) {
                            for (int i = 0; i < items.length(); i++) {
                                JSONObject it = items.optJSONObject(i);
                                if (it != null && it.optLong("seq", 0) > lastSeq) handle(it);
                            }
                        } else handle(j);
                        lastSeq = seq;
                    }
                } catch (Exception e) {
                    wait = 2000;
                }
                try { Thread.sleep(wait); } catch (InterruptedException ie) { return; }
            }
        }, "hongsub-poll");
        poller.start();
    }

    private static JSONObject fetch(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache");
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return new JSONObject(sb.toString());
        } finally {
            c.disconnect();
        }
    }
}
