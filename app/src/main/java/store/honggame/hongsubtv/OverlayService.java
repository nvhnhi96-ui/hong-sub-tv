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
    private GameSound sound;
    private final ArrayDeque<String> mids = new ArrayDeque<>();
    private final ArrayDeque<String> midsImg = new ArrayDeque<>();
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

    /* how loud the voice is, set on the computer (1 = the TV's normal level). Above 1 the voice is amplified:
       the TV's voice and the computer's clips share one audio session with a LoudnessEnhancer on it. */
    private float vol = 1.5f;
    private int voiceSession = 0;
    private android.media.audiofx.LoudnessEnhancer louder = null;
    private int session() {
        if (voiceSession == 0) {
            try { voiceSession = ((android.media.AudioManager) getSystemService(AUDIO_SERVICE)).generateAudioSessionId(); } catch (Exception e) { voiceSession = 0; }
            if (voiceSession > 0) { try { louder = new android.media.audiofx.LoudnessEnhancer(voiceSession); } catch (Exception e) { louder = null; } setVol(vol); }
        }
        return voiceSession;
    }
    private void setVol(float v) {
        vol = v;
        if (louder != null) {
            try { int mb = v > 1f ? (int) (2000 * Math.log10(v)) : 0; louder.setTargetGain(mb); louder.setEnabled(mb > 0); } catch (Exception ignored) { }
        }
    }
    private android.os.Bundle ttsParams() {
        android.os.Bundle b = new android.os.Bundle();
        b.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, Math.min(1f, vol));
        int s = session(); if (s > 0) b.putInt(TextToSpeech.Engine.KEY_PARAM_SESSION_ID, s);
        return b;
    }

    private void clipAdd(String b64, String mime, float rate) {
        try {
            byte[] data = Base64.decode(b64, Base64.DEFAULT);
            if (data.length < 200) return;
            File f = new File(getCacheDir(), "clip" + (++clipSeq % 8) + (mime != null && mime.contains("mpeg") ? ".mp3" : ".wav"));
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(data); }
            safePost(() -> {
                /* a new line is read the moment it comes (its subtitle is on screen now): the line being read stops,
                   unless it is about to end (then the new one follows it). Before, lines waited in turn and the voice
                   on the TV fell further and further behind the subtitles. */
                clips.clear();
                clips.add(new Object[]{f, rate});
                if (clipPlayer != null) {
                    int left = 0;
                    try { left = clipPlayer.getDuration() - clipPlayer.getCurrentPosition(); } catch (Exception ignored) { left = 1000000; }
                    if (left > 450) { try { clipPlayer.stop(); } catch (Exception ignored) { } try { clipPlayer.release(); } catch (Exception ignored) { } clipPlayer = null; }
                }
                if (clipPlayer == null) clipNext();
            });
        } catch (Exception ignored) { }
    }

    private void clipNext() {
        Object[] it = clips.pollFirst();
        if (it == null) return;
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            int s = session(); if (s > 0) mp.setAudioSessionId(s);
            mp.setVolume(Math.min(1f, vol), Math.min(1f, vol));
            mp.setDataSource(((File) it[0]).getAbsolutePath());
            mp.setOnCompletionListener(x -> { x.release(); if (clipPlayer == x) clipPlayer = null; clipNext(); });
            mp.setOnErrorListener((x, a, b) -> { x.release(); if (clipPlayer == x) clipPlayer = null; clipNext(); return true; });
            mp.prepare();
            float r = (Float) it[1];
            if (Math.abs(r - 1f) > 0.01f) { try { mp.setPlaybackParams(new PlaybackParams().setSpeed(r)); } catch (Exception ignored) { } }
            clipPlayer = mp;
            mp.start();
        } catch (Exception e) { clipPlayer = null; safePost(this::clipNext); }
    }

    private void clipStop() {
        safePost(() -> {
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

    static volatile boolean alive = false;

    /* a message the TV cannot draw must not stop the subtitles: kept for "Báo lỗi", the service goes on */
    private void safePost(Runnable r) {
        main.post(() -> { try { r.run(); } catch (Throwable e) { Crash.note(this, e); } });
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Crash.install(this);
        alive = true;
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
                try { tts.setSpeechRate(1.2f); } catch (Exception ignored) { }   // the TV's own voice at 1.0 trails behind the character
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { ttsDone(); }
                    @Override public void onError(String id) { ttsDone(); }
                    @Override public void onStop(String id, boolean interrupted) { ttsDone(); }
                });
            }
        });
        startPolling();
        main.postDelayed(watch, 4000);
        lan = new LanServer(this, prefs, this::handle);
        lan.start();
        sound = new GameSound();   // the game's sound from the computer while the PS plays through Hóng Sub
        sound.start();
        Watchdog.arm(this);
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
        alive = false;
        polling = false;
        nr.close();
        main.removeCallbacks(updLook);
        clipStop();
        if (louder != null) { try { louder.release(); } catch (Exception ignored) { } louder = null; }
        if (lan != null) lan.stop();
        if (sound != null) sound.stop();
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

    /** {{1}}, {{2}}... in an area translation: the button icons cut from the game picture, or a button name like R3 */
    private CharSequence iconText(String raw, JSONArray zic, float px) {
        android.text.SpannableStringBuilder sb = new android.text.SpannableStringBuilder();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\{\\{(\\d+)\\}\\}").matcher(raw);
        int last = 0;
        while (m.find()) {
            sb.append(raw, last, m.start());
            last = m.end();
            int k = Integer.parseInt(m.group(1)) - 1;
            String v = k >= 0 && k < zic.length() ? zic.optString(k, "") : "";
            if (v.startsWith("t:")) { sb.append(v.substring(2)); continue; }
            int c = v.indexOf("base64,");
            if (c < 0) continue;
            try {
                byte[] b = android.util.Base64.decode(v.substring(c + 7), android.util.Base64.DEFAULT);
                android.graphics.Bitmap bm = android.graphics.BitmapFactory.decodeByteArray(b, 0, b.length);
                if (bm == null) continue;
                int hgt = Math.max(8, Math.round(px * 1.05f)), wid = Math.max(8, Math.round(hgt * bm.getWidth() / (float) bm.getHeight()));
                android.graphics.drawable.BitmapDrawable d = new android.graphics.drawable.BitmapDrawable(getResources(), bm);
                d.setBounds(0, 0, wid, hgt);
                int st = sb.length();
                sb.append("\uFFFC");
                sb.setSpan(new android.text.style.ImageSpan(d, Build.VERSION.SDK_INT >= 29 ? android.text.style.DynamicDrawableSpan.ALIGN_CENTER : android.text.style.DynamicDrawableSpan.ALIGN_BOTTOM),
                        st, st + 1, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            } catch (Exception e) { /* a broken picture: left out */ }
        }
        sb.append(raw.substring(last));
        return sb;
    }

    /** the same text with a letter-wide stand-in for each icon, to measure the lines */
    private static String iconMeasure(String raw, JSONArray zic) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\{\\{(\\d+)\\}\\}").matcher(raw);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            int k = Integer.parseInt(m.group(1)) - 1;
            String v = k >= 0 && k < zic.length() ? zic.optString(k, "") : "";
            m.appendReplacement(out, java.util.regex.Matcher.quoteReplacement(v.startsWith("t:") ? v.substring(2) : v.isEmpty() ? "" : "WW"));
        }
        m.appendTail(out);
        return out.toString();
    }

    private void zoneShow(JSONObject j, String vi0) {
        final String id = j.optString("zid", "");
        if (id.isEmpty()) return;
        final String zv = j.optString("zv", "");
        final JSONArray zic = j.optJSONArray("zic");
        final boolean icons = !zv.isEmpty() && zic != null && zic.length() > 0 && !vi0.isEmpty();
        final String vi = icons ? iconMeasure(zv, zic) : vi0;   // with the game's button icons ({{1}}...) when the computer sends them
        final float zsc = (float) Math.max(0.3, Math.min(1.6, j.optInt("zsc", 100) / 100.0));   // "Cỡ chữ" of the area: share of the original's size
        final boolean grow0 = j.optInt("zgrow", 0) == 1;   // a paragraph over its own original: no minimum size, a tight box like on the computer
        final double x = j.optDouble("x", 0), y = j.optDouble("y", 0), w = Math.max(grow0 ? 0.005 : 0.06, j.optDouble("w", 0.3)), h = Math.max(grow0 ? 0.005 : 0.04, j.optDouble("h", 0.15));
        final int hold = j.optInt("hold", 0);
        final String zs = j.optString("zs", "m");
        final int zpx = Math.max(0, Math.min(80, j.optInt("zpx", 0)));
        final String zal = j.optString("zal", "l");
        final boolean zfit = j.optBoolean("zfit", false);
        final boolean zgrow = j.optInt("zgrow", 0) == 1;
        final double zmaxw = j.optDouble("zmaxw", 0);
        final int zbg = j.has("zbg") ? Math.max(0, Math.min(100, j.optInt("zbg", 90))) : 90;
        final String fk = j.optString("zfont", j.optString("font", prefs.font()));
        final Typeface face = j.optInt("zwt", 0) == 600 ? faceSemi(fk) : faceFor(fk);   // the area's own font ("Kiểu chữ" of the area), else the subtitle's; screen text a lighter weight like the computer's
        final boolean zauto = j.optInt("zauto", 1) == 1;   // size read from the original (not one chosen on the computer)
        final double zx = j.optDouble("zx", 0), zw = j.optDouble("zw", 0);   // the whole area: how far a box may widen
        final String zbgc = j.optString("zbgc", ""), zfgc = j.optString("zfg", "");   // "Theo màu game": colours around the original
        // the box as a picture drawn on the computer (screen text over the home network): shown as it is, at its place,
        // so the TV looks exactly like the computer
        android.graphics.Bitmap bm0 = null;
        String zimg = j.optString("zimg", "");
        if (!zimg.isEmpty()) {
            try {
                byte[] d = Base64.decode(zimg.substring(zimg.indexOf(',') + 1), Base64.DEFAULT);
                bm0 = android.graphics.BitmapFactory.decodeByteArray(d, 0, d.length);
            } catch (Throwable e) { bm0 = null; }
        }
        final android.graphics.Bitmap bm = bm0;
        final double ix = j.optDouble("zix", x), iy = j.optDouble("ziy", y), iw = j.optDouble("ziw", w), ih = j.optDouble("zih", h);
        safePost(() -> {
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
            if (bm != null) {
                DisplayMetrics dmi = new DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(dmi);
                int Wi = dmi.widthPixels, Hi = dmi.heightPixels;
                FrameLayout.LayoutParams fli = new FrameLayout.LayoutParams(Math.max(1, (int) Math.round(iw * Wi)), Math.max(1, (int) Math.round(ih * Hi)));
                fli.leftMargin = (int) Math.round(ix * Wi);
                fli.topMargin = (int) Math.round(iy * Hi);
                if (Build.VERSION.SDK_INT >= 26) tv.setAutoSizeTextTypeWithDefaults(TextView.AUTO_SIZE_TEXT_TYPE_NONE);
                tv.setMinWidth(0); tv.setMinHeight(0); tv.setMaxWidth(Integer.MAX_VALUE); tv.setMaxHeight(Integer.MAX_VALUE);
                tv.setText("");
                tv.setPadding(0, 0, 0, 0);
                tv.setShadowLayer(0f, 0f, 0f, Color.TRANSPARENT);
                tv.setLayoutParams(fli);
                android.graphics.drawable.BitmapDrawable bd = new android.graphics.drawable.BitmapDrawable(getResources(), bm);
                bd.setFilterBitmap(true);
                tv.setBackground(bd);
                final TextView vi2 = tv;
                Runnable offI = () -> { zoneLayer.removeView(vi2); zoneViews.remove(id); zoneOff.remove(id); };
                zoneOff.put(id, offI);
                main.postDelayed(offI, hold > 0 ? hold * 1000L : 300000L);
                return;
            }
            if (zgrow) {   // "Đúng chỗ": one paragraph right over its own original
                spotBox(tv, vi, face, zal, zbg, zpx, zauto, x, y, w, h, zx, zw, zmaxw, zbgc, zfgc);
                if (icons) tv.setText(iconText(zv, zic, tv.getTextSize()));
                final TextView vs = tv;
                Runnable offS = () -> { zoneLayer.removeView(vs); zoneViews.remove(id); zoneOff.remove(id); };
                zoneOff.put(id, offS);
                main.postDelayed(offS, hold > 0 ? hold * 1000L : 300000L);
                return;
            }
            tv.setMaxHeight(Integer.MAX_VALUE);
            DisplayMetrics dm = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            int W = dm.widthPixels, H = dm.heightPixels, bw = (int) (w * W), bh = (int) (h * H);
            // at least the original's size, wider for bigger letters (up to the area's right edge)
            final int maxW = zgrow ? Math.max(bw, (int) (Math.max(w, zmaxw) * W)) : bw;
            FrameLayout.LayoutParams fl = new FrameLayout.LayoutParams(zgrow ? FrameLayout.LayoutParams.WRAP_CONTENT : bw, zpx > 0 ? FrameLayout.LayoutParams.WRAP_CONTENT : bh);
            tv.setMinWidth(zgrow ? bw : 0); tv.setMaxWidth(maxW);
            fl.leftMargin = (int) (x * W);
            fl.topMargin = (int) (y * H);
            tv.setLayoutParams(fl);
            tv.setText(vi);
            GradientDrawable zb = new GradientDrawable();
            zb.setColor(Color.argb(Math.round(zbg * 2.55f), 8, 9, 12));
            zb.setCornerRadius(zgrow ? dp(3) : dp(5));
            tv.setBackground(zb);
            tv.setTypeface(face);
            if (zgrow) { tv.setPadding(dp(3), 0, dp(3), 0); tv.setIncludeFontPadding(false); tv.setLineSpacing(0f, 1.1f); }
            else { tv.setPadding(dp(8), dp(5), dp(8), dp(5)); tv.setIncludeFontPadding(true); tv.setLineSpacing(0f, 1f); }
            tv.setGravity(("c".equals(zal) ? Gravity.CENTER_HORIZONTAL : "r".equals(zal) ? Gravity.RIGHT : Gravity.LEFT) | Gravity.TOP);   // lined up like the original text
            if (zpx > 0) {
                // the size chosen on the computer (on a 1080-line screen); the box grows down if the text needs it
                if (Build.VERSION.SDK_INT >= 26) tv.setAutoSizeTextTypeWithDefaults(TextView.AUTO_SIZE_TEXT_TYPE_NONE);
                tv.setMinHeight(bh);
                tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, zpx * (H / 1080f));
                tv.setHorizontallyScrolling(false);
                if (zfit) {   // same lines as the original paragraph: smaller letters instead of an extra line
                    float widest = 0;
                    for (String line : vi.split("\n")) widest = Math.max(widest, tv.getPaint().measureText(line));
                    int avail = maxW - tv.getPaddingLeft() - tv.getPaddingRight();
                    if (widest > avail && avail > 0) tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(6f, tv.getTextSize() * avail / widest * 0.96f));
                }
                if (icons) tv.setText(iconText(zv, zic, tv.getTextSize()));
                final TextView v2 = tv;
                Runnable off2 = () -> { zoneLayer.removeView(v2); zoneViews.remove(id); zoneOff.remove(id); };
                zoneOff.put(id, off2);
                main.postDelayed(off2, hold > 0 ? hold * 1000L : 300000L);
                return;
            }
            tv.setMinHeight(0);
            // as big as the area allows, smaller for long text
            float cap = (zs.equals("xs") ? 20 : zs.equals("s") ? 26 : zs.equals("l") ? 44 : zs.equals("xl") ? 56 : 34) * (H / 1080f) * zsc;
            int lines = vi.split("\n").length;
            float fit = Math.max(8f, Math.min(cap, bh / (float) lines * 0.62f * zsc));
            if (Build.VERSION.SDK_INT >= 26) {
                tv.setAutoSizeTextTypeUniformWithConfiguration(Math.max(6, Math.min(10, (int) fit - 1)), Math.max(7, (int) fit), 1, TypedValue.COMPLEX_UNIT_PX);
            } else {
                tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, fit);
            }
            if (icons) tv.setText(iconText(zv, zic, fit));
            final TextView view = tv;
            Runnable off = () -> { zoneLayer.removeView(view); zoneViews.remove(id); zoneOff.remove(id); };
            zoneOff.put(id, off);
            main.postDelayed(off, hold > 0 ? hold * 1000L : 300000L);
        });
    }

    /* "Đúng chỗ": the Vietnamese right over its own original paragraph, so the English under it is hidden.
       - the box is never smaller than the original text and is centred on it
       - the Vietnamese keeps its lines (the same number as the original): no extra wrapping
       - with the size read from the original, the lines fit the original's height, so a box never runs onto the next
         line of a menu
       - a longer Vietnamese line widens the box inside the area (on the side the text is lined up); past that the
         letters get smaller.
       Every size is worked out here and set exactly, so no TV draws it differently. */
    private void spotBox(TextView tv, String vi, Typeface face, String zal, int zbg, int zpx, boolean auto,
                         double x, double y, double w, double h, double zx, double zw, double zmaxw, String bgc, String fgc) {
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        int W = dm.widthPixels, H = dm.heightPixels;
        float bx = (float) (x * W), by = (float) (y * H), bw = (float) Math.max(2, w * W), bh = (float) Math.max(2, h * H);
        float room;
        if (zw > 0.01) {
            float L = (float) (zx * W), R = (float) ((zx + zw) * W), cx = bx + bw / 2;
            room = "r".equals(zal) ? (bx + bw) - L : "c".equals(zal) ? 2 * Math.min(cx - L, R - cx) : R - bx;
        } else room = (float) (Math.max(w, zmaxw) * W);
        room = Math.max(bw, Math.min(room, W));
        if (Build.VERSION.SDK_INT >= 26) tv.setAutoSizeTextTypeWithDefaults(TextView.AUTO_SIZE_TEXT_TYPE_NONE);
        tv.setTypeface(face);
        tv.setIncludeFontPadding(false);
        tv.setLineSpacing(0f, 1f);
        tv.setHorizontallyScrolling(false);
        tv.setMinWidth(0); tv.setMinHeight(0); tv.setMaxWidth(Integer.MAX_VALUE); tv.setMaxHeight(Integer.MAX_VALUE);
        tv.setText(vi);
        String[] lines = vi.split("\n");
        int n = Math.max(1, lines.length);
        int padH = dp(4), slack = dp(4);
        float padK = 0.12f;   // room above and below the lines, per pixel of letter size
        float f = Math.max(6f, (zpx > 0 ? zpx : 22) * H / 1080f);
        final float f0 = f;
        android.text.TextPaint p = new android.text.TextPaint(tv.getPaint());
        p.setTypeface(face);
        p.setTextSize(f);
        android.graphics.Paint.FontMetrics fm = p.getFontMetrics();
        float lineK = (fm.descent - fm.ascent) / f;
        if (auto) {
            float maxH = bh * 1.1f, need = f * (n * lineK + 2 * padK);
            if (need > maxH) f = Math.max(6f, maxH / (n * lineK + 2 * padK));
        }
        for (int i = 0; i < 3; i++) {
            p.setTextSize(f);
            float widest = 0;
            for (String s : lines) widest = Math.max(widest, p.measureText(s));
            float avail = room - 2 * padH - slack;
            if (widest <= avail || avail <= 0 || f <= 6f) break;
            f = Math.max(6f, f * avail / widest * 0.99f);
        }
        // Lines too long for the room (a paragraph that came as fewer lines than the original): wrapped inside the
        // original's box at the biggest size that fits its height, like the computer draws it, instead of one line of
        // tiny letters. Kept only when it gives bigger letters than keeping the lines.
        android.text.StaticLayout wrap = null;
        float availW = room - 2 * padH - slack;
        if (availW > 8 && f < f0 * 0.9f) {
            float maxH = bh * 1.15f;
            for (float g = f0; g > f * 1.05f && g > 6f; g *= 0.94f) {
                p.setTextSize(g);
                android.text.StaticLayout sl = makeLayout(vi, p, (int) availW);
                if (sl.getHeight() + 2 * g * padK <= maxH) { wrap = sl; f = g; break; }
            }
        }
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, f);
        p.setTextSize(f);
        float widest = 0;
        int rows = n;
        if (wrap != null) { for (int i = 0; i < wrap.getLineCount(); i++) widest = Math.max(widest, wrap.getLineWidth(i)); rows = wrap.getLineCount(); }
        else for (String s : lines) widest = Math.max(widest, p.measureText(s));
        if (Build.VERSION.SDK_INT >= 23) { tv.setBreakStrategy(android.text.Layout.BREAK_STRATEGY_SIMPLE); tv.setHyphenationFrequency(android.text.Layout.HYPHENATION_FREQUENCY_NONE); }
        android.graphics.Paint.FontMetricsInt fi = p.getFontMetricsInt();
        int padV = Math.round(f * padK);
        int boxW = (int) Math.ceil(Math.min(Math.max(room, bw), Math.max(bw, widest + 2 * padH + slack)));
        int boxH = (int) Math.ceil(Math.max(bh, wrap != null ? wrap.getHeight() + 2 * padV : rows * (fi.descent - fi.ascent) + 2 * padV));
        float left = "r".equals(zal) ? bx + bw - boxW : "c".equals(zal) ? bx + bw / 2 - boxW / 2f : bx;
        left = Math.max(0, Math.min(W - boxW, left));
        float top = Math.max(0, Math.min(H - boxH, by + bh / 2 - boxH / 2f));
        FrameLayout.LayoutParams fl = new FrameLayout.LayoutParams(boxW, boxH);
        fl.leftMargin = Math.round(left);
        fl.topMargin = Math.round(top);
        tv.setLayoutParams(fl);
        tv.setPadding(padH, 0, padH, 0);
        tv.setGravity(("c".equals(zal) ? Gravity.CENTER_HORIZONTAL : "r".equals(zal) ? Gravity.RIGHT : Gravity.LEFT) | Gravity.CENTER_VERTICAL);
        int a = Math.round(zbg * 2.55f);
        int bg = 0;
        boolean game = bgc != null && bgc.matches("#[0-9A-Fa-f]{6}");
        if (game) { try { bg = Color.parseColor(bgc); } catch (Exception e) { game = false; } }
        if (game) {
            // "Theo màu game": a flat patch of the picture's own colour, square-cornered and edge to edge with the
            // text, like the computer draws it. (Soft fading edges were drawn by some TVs as a dark rim, so the
            // box looked like a button.)
            GradientDrawable zb = new GradientDrawable();
            zb.setColor(Color.argb(255, Color.red(bg), Color.green(bg), Color.blue(bg)));
            zb.setCornerRadius(dp(1));
            tv.setBackground(zb);
            int fg = Color.WHITE;
            try { if (fgc != null && fgc.matches("#[0-9A-Fa-f]{6}")) fg = Color.parseColor(fgc); } catch (Exception ignored) { }
            tv.setTextColor(fg);
            tv.setShadowLayer(0f, 0f, 0f, Color.TRANSPARENT);
        } else {
            GradientDrawable zb = new GradientDrawable();
            zb.setColor(Color.argb(a, 8, 9, 12));
            zb.setCornerRadius(dp(3));
            tv.setBackground(zb);
            tv.setTextColor(Color.WHITE);
            tv.setShadowLayer(3f, 0f, 1f, Color.BLACK);
        }
    }

    private static android.text.StaticLayout makeLayout(String t, android.text.TextPaint p, int w) {
        if (Build.VERSION.SDK_INT >= 23)
            return android.text.StaticLayout.Builder.obtain(t, 0, t.length(), p, w).setIncludePad(false)
                .setBreakStrategy(android.text.Layout.BREAK_STRATEGY_SIMPLE).setHyphenationFrequency(android.text.Layout.HYPHENATION_FREQUENCY_NONE).build();
        return new android.text.StaticLayout(t, p, w, android.text.Layout.Alignment.ALIGN_NORMAL, 1f, 0f, false);
    }

    /** The typeface picked on the computer, as close as Android TV's own fonts allow. */
    /* the same letters as on the computer: each font is bundled (latin + Vietnamese), the system font is the fallback */
    private final java.util.HashMap<String, Typeface> faces = new java.util.HashMap<>();
    private synchronized Typeface faceFor(String k) {
        if (k == null || !k.matches("[a-z]{2,12}")) k = "bevn";
        Typeface t = faces.get(k);
        if (t != null) return t;
        try { t = Typeface.createFromAsset(getAssets(), "fonts/" + k + ".ttf"); } catch (Exception e) { t = null; }
        if (t == null) {
            String fam = "sans-serif";
            if ("notoserif".equals(k)) fam = "serif";
            else if ("oswald".equals(k) || "barlow".equals(k)) fam = "sans-serif-condensed";
            t = Typeface.create(fam, Typeface.BOLD);
        }
        faces.put(k, t);
        return t;
    }

    /* the half-bold cut of a font (600, the weight the computer draws screen text in) when the app has it */
    private synchronized Typeface faceSemi(String k) {
        if (k == null || !k.matches("[a-z]{2,12}")) k = "bevn";
        String key = k + "sb";
        Typeface t = faces.get(key);
        if (t != null) return t;
        try { t = Typeface.createFromAsset(getAssets(), "fonts/" + key + ".ttf"); } catch (Exception e) { t = null; }
        if (t == null) t = faceFor(k);
        faces.put(key, t);
        return t;
    }

    private double[] cov = null;
    // the game's own subtitle when the Vietnamese does not cover it: the Vietnamese goes right above it
    private double[] abv = null;
    // "đè đúng chỗ từng dòng": over the original text itself, its alignment and its letter size (on a 1080-line screen)
    private boolean covSpot = false; private String covAl = "c"; private int covFs = 0;
    private double covXb = 0; private boolean covCaps = false;
    private double abvXb = 0; private boolean abvCaps = false;   // above the English: the English letters' own height   // the original letters' own height (part of the screen) and whether they are capitals   // the original subtitle's place (x, y, w, h as parts of the screen), or null

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
            // as wide as "Độ rộng khung phụ đề" says, centred on the original subtitle, with the chosen background
            int bw = Math.max(dp(120), (int) (prefs.width() / 100f * dm.widthPixels));
            int cx = (int) ((cov[0] + cov[2] / 2) * dm.widthPixels);
            lp.x = Math.max(0, Math.min(dm.widthPixels - bw, cx - bw / 2)); lp.y = (int) (cov[1] * dm.heightPixels);
            // "Độ cao khung nền": taller or flatter than the original line, centred on it
            lp.width = bw; lp.height = Math.max(dp(26), (int) (cov[3] * dm.heightPixels * prefs.boxH() / 100f));
            lp.y = Math.max(0, (int) ((cov[1] + cov[3] / 2) * dm.heightPixels) - lp.height / 2);
            viView.setMaxWidth(lp.width);
            GradientDrawable cb = new GradientDrawable();
            cb.setColor(Color.argb(Math.round(prefs.bg() * 2.55f), 8, 8, 10));
            cb.setCornerRadius(dp(4));
            box.setBackground(cb);
            box.setGravity(Gravity.CENTER);
        } else {
            // "Độ rộng khung phụ đề": the box is exactly that share of the screen wide, centred
            lp.width = Math.max(dp(160), (int) (screenW * w)); lp.height = WindowManager.LayoutParams.WRAP_CONTENT; lp.x = 0; box.setGravity(Gravity.CENTER_HORIZONTAL);
            viView.setMaxWidth(lp.width); enView.setMaxWidth(lp.width);
            lp.gravity = (prefs.top() ? Gravity.TOP : Gravity.BOTTOM) | Gravity.CENTER_HORIZONTAL;
            lp.y = dp(prefs.top() ? 36 : 46);
            if (abv != null && !prefs.top()) {
                // right above the game's own (English) subtitle, centred on it: the two never run over each other
                DisplayMetrics dm = new DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(dm);
                lp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
                lp.y = Math.max(0, (int) ((1 - abv[1]) * dm.heightPixels) + dp(2));
                int cx = (int) ((abv[0] + abv[2] / 2) * dm.widthPixels);
                lp.x = Math.max(-(dm.widthPixels - lp.width) / 2, Math.min((dm.widthPixels - lp.width) / 2, cx - dm.widthPixels / 2));
            }
            float k = prefs.boxH() / 100f;
            box.setPadding(dp(22), (int) (dp(10) * k), dp(22), (int) (dp(12) * k));
        }
        try { wm.updateViewLayout(box, lp); } catch (Exception ignored) { }
        fitLines();
    }

    /* "same lines as the original": no extra wrapping, the letters get smaller until the longest line fits */
    private void fitLines() {
        int size = prefs.textSize();
        boolean lm = prefs.lines() || (cov != null && covSpot);
        viView.setHorizontallyScrolling(false);   // never: with centred text it draws the words off screen
        viView.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        if (cov == null && abv != null && abvXb > 0 && !prefs.top()) {   // right above the English: as tall as its letters, "Cỡ chữ" 30 = the same
            DisplayMetrics dm = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            viView.setTextSize(TypedValue.COMPLEX_UNIT_PX, (float) (abvXb * dm.heightPixels) / letterRatio(abvCaps) * Math.max(0.4f, Math.min(2.5f, size / 30f)));
        }
        if (cov != null && covSpot && covFs > 0) {
            DisplayMetrics dm = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            // the original letters' size, made bigger or smaller by "Cỡ chữ" on the computer (28 there = 30 here = as the original)
            float k = Math.max(0.4f, Math.min(2.5f, size / 30f)), px = covFs * dm.heightPixels / 1080f;
            if (covXb > 0) {   // the letters as tall as the original's, measured with this TV's own font
                float r = letterRatio(covCaps), want = (float) (covXb * dm.heightPixels) / r;
                px = Math.max(px * 0.6f, Math.min(px * 1.5f, want));
            }
            viView.setTextSize(TypedValue.COMPLEX_UNIT_PX, px * k);
            float need = 0;
            for (String line : viView.getText().toString().split("\\n")) need = Math.max(need, viView.getPaint().measureText(line));
            int base = (int) (cov[2] * dm.widthPixels), maxW = (int) (prefs.width() / 100f * dm.widthPixels);
            int bw = Math.max(base, Math.min(maxW, (int) need + box.getPaddingLeft() + box.getPaddingRight() + dp(8)));
            int x = "l".equals(covAl) ? (int) (cov[0] * dm.widthPixels) : "r".equals(covAl) ? (int) ((cov[0] + cov[2]) * dm.widthPixels) - bw : (int) ((cov[0] + cov[2] / 2) * dm.widthPixels) - bw / 2;
            lp.width = bw; lp.x = Math.max(0, Math.min(dm.widthPixels - bw, x));
            box.setGravity(("l".equals(covAl) ? Gravity.LEFT : "r".equals(covAl) ? Gravity.RIGHT : Gravity.CENTER_HORIZONTAL) | Gravity.CENTER_VERTICAL);
            box.setPadding(dp(6), dp(2), dp(6), dp(2));
            try { wm.updateViewLayout(box, lp); } catch (Exception ignored) { }
        }
        if (!lm) { coverHeight(); return; }
        int avail = (cov != null ? lp.width : (lp.width > 0 ? lp.width : getResources().getDisplayMetrics().widthPixels)) - box.getPaddingLeft() - box.getPaddingRight() - dp(4);
        if (avail <= 0) return;
        float widest = 0;
        for (String line : viView.getText().toString().split("\n")) widest = Math.max(widest, viView.getPaint().measureText(line));
        // too long for the original's lines: the words go on another line and the letters keep their size,
        // so every subtitle is the same size (they only get smaller if the box would cover almost half the screen)
        if (widest > avail) {
            CharSequence t = viView.getText();
            if (t.toString().indexOf('\n') >= 0) viView.setText(t.toString().replace('\n', ' '));
            int sh = getResources().getDisplayMetrics().heightPixels;
            for (int i = 0; i < 12 && wrapLines(avail) * viView.getLineHeight() > sh * 0.42f && viView.getTextSize() > dp(9); i++)
                viView.setTextSize(TypedValue.COMPLEX_UNIT_PX, viView.getTextSize() * 0.9f);
        }
        coverHeight();
    }

    /* how tall this TV's font draws a lower-case "x" (or a capital "H"), as a part of the font size */
    private float letterRatio(boolean caps) {
        try {
            android.graphics.Paint p = new android.graphics.Paint(viView.getPaint());
            p.setTextSize(200f);
            android.graphics.Rect r = new android.graphics.Rect();
            p.getTextBounds(caps ? "H" : "x", 0, 1, r);
            float v = -r.top / 200f;
            if (v > 0.3f && v < 0.95f) return v;
        } catch (Exception ignored) { }
        return caps ? 0.72f : 0.53f;
    }

    /* how many lines the Vietnamese takes in this width (its own line breaks, plus words wrapped onto a new line) */
    private int wrapLines(int w) {
        String t = viView.getText().toString();
        if (w <= 0) return Math.max(1, t.split("\n").length);
        android.text.StaticLayout l = new android.text.StaticLayout(t, viView.getPaint(), w, android.text.Layout.Alignment.ALIGN_NORMAL, 1f, 0f, false);
        return Math.max(1, l.getLineCount());
    }

    /* over the original subtitle: the box is at least as tall as the Vietnamese lines (never cuts the letters), centred on the original */
    private void coverHeight() {
        if (cov == null || box == null) return;
        viView.setIncludeFontPadding(false);
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        int lines = Math.max(1, wrapLines(lp.width > 0 ? lp.width - box.getPaddingLeft() - box.getPaddingRight() - dp(4) : 0));
        int need = (int) (lines * viView.getLineHeight() * 1.08f) + box.getPaddingTop() + box.getPaddingBottom() + (enView.getVisibility() == View.VISIBLE ? (int) (enView.getLineHeight() * 1.3f) : 0);
        int want = Math.max((int) (cov[3] * dm.heightPixels * prefs.boxH() / 100f), need);
        if (want != lp.height) {
            lp.height = Math.max(dp(26), want);
            lp.y = Math.max(0, Math.min(dm.heightPixels - lp.height, (int) ((cov[1] + cov[3] / 2) * dm.heightPixels) - lp.height / 2));
            try { wm.updateViewLayout(box, lp); } catch (Exception ignored) { }
        }
    }

    /* several people talking at once: the colour of each line (the game's own colour of that person's words) */
    private volatile JSONArray lineCols = null;

    private void showLine(String who, String vi, String en, long holdMs, boolean speakIt) {
        final JSONArray lc = lineCols; lineCols = null;
        safePost(() -> {
            if (box == null) return;
            SpannableStringBuilder sb = new SpannableStringBuilder();
            if (who != null && !who.isEmpty()) {
                sb.append(who).append(": ");
                sb.setSpan(new ForegroundColorSpan(Color.rgb(255, 196, 0)), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            int at = sb.length();
            sb.append(vi);
            if (lc != null) {
                String[] ls = vi.split("\n", -1);
                int p = at;
                for (int i = 0; i < ls.length; i++) {
                    String c = i < lc.length() ? lc.optString(i, "") : "";
                    if (c.matches("#[0-9A-Fa-f]{6}")) sb.setSpan(new ForegroundColorSpan(Color.parseColor(c)), p, p + ls[i].length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    p += ls[i].length() + 1;
                }
            }
            viView.setText(sb);
            boolean en1 = prefs.showEn() && en != null && !en.isEmpty();
            enView.setText(en1 ? en : "");
            enView.setVisibility(en1 ? View.VISIBLE : View.GONE);
            fitLines();
            box.setVisibility(View.VISIBLE);
            main.removeCallbacks(hideRunnable);
            main.postDelayed(hideRunnable, holdMs);
            if (speakIt && ttsReady) {   // read the moment it shows: the line being read stops
                ttsPending.set(1);
                tts.speak(vi, TextToSpeech.QUEUE_FLUSH, ttsParams(), "line" + (++ttsSeq));
            }
        });
    }

    /* Hóng Sub on the computer says "still here" every 10 s while area boxes are on the TV (hb). When that stops
       (Hóng Sub closed, computer asleep, network gone) the boxes go away by themselves instead of staying for minutes. */
    private volatile long pcAt = 0;
    private volatile boolean hbOn = false;
    private static final long PC_QUIET_MS = 32000;
    private final Runnable watch = new Runnable() {
        @Override public void run() {
            if (hbOn && !zoneViews.isEmpty() && android.os.SystemClock.elapsedRealtime() - pcAt > PC_QUIET_MS) zonesClear();
            main.postDelayed(this, 4000);
        }
    };

    /* What the computer says should be on the TV now (every few seconds while something is up): a subtitle the
       computer no longer shows, or a screen-text box past the computer's count, comes off. A taking-off message lost on
       the way no longer leaves old Vietnamese on the TV. */
    private volatile long subSid = 0, subAt = 0;
    private void syncState(JSONObject j) {
        if (j.has("sv") && j.optInt("sv", 1) == 0 && j.optLong("sid", 0) >= subSid
                && android.os.SystemClock.elapsedRealtime() - subAt > 1200) { main.removeCallbacks(hideRunnable); safePost(hideRunnable); }
        if (j.has("fsn")) {
            final int n = j.optInt("fsn", 0);
            safePost(() -> {
                java.util.List<String> off = new java.util.ArrayList<>();
                for (String id : zoneViews.keySet()) if (id.startsWith("fs_")) { try { if (Integer.parseInt(id.substring(3)) >= n) off.add(id); } catch (Exception e) {} }
                for (String id : off) { android.view.View v = zoneViews.remove(id); if (v != null && zoneLayer != null) zoneLayer.removeView(v); Runnable r = zoneOff.remove(id); if (r != null) main.removeCallbacks(r); }
            });
        }
    }

    /** every area box off the TV (on the main thread) */
    private void zonesClear() {
        safePost(() -> {
            for (Runnable r : zoneOff.values()) main.removeCallbacks(r);
            zoneOff.clear();
            if (zoneLayer != null) zoneLayer.removeAllViews();
            zoneViews.clear();
        });
    }

    /** one message from the computer (through honggame.store or straight over the home network) */
    void handle(JSONObject j) {
        try { handleOne(j); } catch (Throwable e) { Crash.note(this, e); }
    }

    private void handleOne(JSONObject j) {
        pcAt = android.os.SystemClock.elapsedRealtime();
        if (j.has("hb")) hbOn = true;
        String mid = j.optString("mid", "");
        boolean img = !j.optString("zimg", "").isEmpty();   // a box as the computer drew it (home network only)
        if (!mid.isEmpty()) {
            synchronized (mids) {
                // the copy through honggame.store (text only) may come first: the picture of the same box still
                // replaces it, and a text copy after the picture is dropped
                if (mids.contains(mid)) { if (!img || midsImg.contains(mid)) return; }
                else { mids.add(mid); if (mids.size() > 60) mids.poll(); }
                if (img) { midsImg.add(mid); if (midsImg.size() > 60) midsImg.poll(); }
            }
        }
        String vi = j.optString("vi", "");
        // text size and position chosen on the computer
        int size = j.optInt("size", 0);
        String pos = j.optString("pos", "");
        boolean changed = false;
        if (size >= 10 && size != prefs.textSize()) { prefs.textSize(size); changed = true; }
        if (j.has("hgt")) { int hg = j.optInt("hgt", 100); if (hg >= 40 && hg <= 300 && hg != prefs.boxH()) { prefs.boxH(hg); changed = true; } }
        if (j.has("lm") && j.optBoolean("lm", true) != prefs.lines()) { prefs.lines(j.optBoolean("lm", true)); changed = true; }
        if (j.has("sen") && j.optBoolean("sen", false) != prefs.showEn()) { prefs.showEn(j.optBoolean("sen", false)); }   // English line: set on the computer
        if (j.has("cov")) {
            JSONObject c = j.optJSONObject("cov");
            double[] nc = c != null && c.optDouble("w", 0) > 0.02 && c.optDouble("h", 0) > 0.02
                    ? new double[]{c.optDouble("x", 0), c.optDouble("y", 0), c.optDouble("w", 0), c.optDouble("h", 0)} : null;
            if (!java.util.Arrays.equals(nc, cov)) { cov = nc; changed = true; }
            boolean sp = nc != null && j.optInt("cspot", 0) == 1; String al = j.optString("cal", "c"); int fs = j.optInt("cfs", 0);
            double xb = j.optDouble("cxb", 0); if (!(xb > 0 && xb < 0.3)) xb = 0; boolean cp = j.optInt("ccap", 0) == 1;
            if (sp != covSpot || !al.equals(covAl) || fs != covFs || xb != covXb || cp != covCaps) { covSpot = sp; covAl = al; covFs = fs; covXb = xb; covCaps = cp; changed = true; }
        }
        if (j.has("abv")) {
            JSONObject c = j.optJSONObject("abv");
            double[] na = c != null && c.optDouble("w", 0) > 0.02 && c.optDouble("y", 0) > 0.1
                    ? new double[]{c.optDouble("x", 0), c.optDouble("y", 0), c.optDouble("w", 0), c.optDouble("h", 0)} : null;
            // small moves of the found lines do not move the box (it would jump with every line)
            boolean far = na == null || abv == null || Math.abs(na[1] - abv[1]) > 0.015 || Math.abs((na[0] + na[2] / 2) - (abv[0] + abv[2] / 2)) > 0.03;
            if (far && !java.util.Arrays.equals(na, abv)) { abv = na; changed = true; }
            double ax = na != null ? j.optDouble("axb", 0) : 0; if (!(ax > 0 && ax < 0.3)) ax = 0; boolean ac = j.optInt("acap", 0) == 1;
            if (Math.abs(ax - abvXb) > 0.0008 || ac != abvCaps) { abvXb = ax; abvCaps = ac; changed = true; }
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
        if (j.has("vol")) { int v = j.optInt("vol", 150); if (v >= 30 && v <= 300) setVol(v / 100f); }
        if (j.has("wid")) { int w = j.optInt("wid", 0); if (w >= 20 && w <= 100 && w != prefs.width()) { prefs.width(w); changed = true; } }
        if (pos.equals("top") && !prefs.top()) { prefs.top(true); changed = true; }
        if (pos.equals("bottom") && prefs.top()) { prefs.top(false); changed = true; }
        if (changed) safePost(this::applyStyle);
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
        else if (kind.equals("hb")) { syncState(j); }   // "still here", with what should be on the TV now
        else if (kind.equals("clr")) { main.removeCallbacks(hideRunnable); safePost(hideRunnable); }   // the game's own subtitle is gone: so is the Vietnamese
        else if (kind.equals("zone") && j.optInt("zclr", 0) == 1) zonesClear();   // Hóng Sub stopped: every area box off
        else if (kind.equals("zone")) {
            zoneShow(j, vi);   // read aloud only when the area asks for it on the computer
            if (!vi.isEmpty() && read && ttsReady) { ttsPending.incrementAndGet(); tts.speak(vi.replace("\n", ". ").replace("●", ""), TextToSpeech.QUEUE_ADD, ttsParams(), "zone" + (++ttsSeq)); }
        }
        else if (kind.equals("notice")) {
            // a message from Hóng Sub on the computer (app opened, PS5 waking...): shown, not read aloud
            if (!vi.isEmpty()) showLine(j.optString("who", "Hóng Sub"), vi, "", 6000, false);
        }
        else if (!vi.isEmpty()) {
            if (j.has("sid")) subSid = j.optLong("sid", 0);
            subAt = android.os.SystemClock.elapsedRealtime();
            long hold = Math.max(4500, Math.min(12000, vi.length() * 110L));
            lineCols = j.optJSONArray("lc");
            showLine(j.optString("who", ""), vi, j.optString("en", ""), hold, read);
        }
    }

    /** tells the computer that this TV is on: Hóng Sub on the computer then wakes the PS5 and answers */
    private void hello() { tell("hello", ""); }

    /* "still listening" every 30 s on the TV's own room: Hóng Sub on the computer knows the TV app is on (and gets a crash report) */
    private long aliveAt = 0;
    private void alive() {
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - aliveAt < 30000) return;
        aliveAt = now;
        tell("alive", Crash.take(this));
    }

    /* the new relay: lines come over one WebSocket; honggame.store only while it is down */
    private final NrRelay nr = new NrRelay(it -> handle(unpack(it)));
    private int tells = 0;

    private void tell(String kind, String crash) {
        boolean viaNr = false;
        try {
            nr.sync(prefs.code());
            JSONObject x = new JSONObject().put("ip", LanServer.ip());
            if (crash != null && !crash.isEmpty()) x.put("crash", crash.length() > 380 ? crash.substring(0, 380) : crash);
            viaNr = nr.tell(new JSONObject().put("kind", kind).put("vi", "tv " + Updater.current(this)).put("en", pack(x)));
        } catch (Exception ignored) { }
        /* honggame.store too, for a computer still on an older Hóng Sub: every hello, every other alive */
        if (viaNr && !"hello".equals(kind) && (tells++ % 2) != 0) return;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(Prefs.RELAY.replace("pull?room=", "push")).openConnection();
            c.setConnectTimeout(5000); c.setReadTimeout(5000); c.setDoOutput(true); c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            JSONObject x = new JSONObject().put("ip", LanServer.ip());
            if (crash != null && !crash.isEmpty()) x.put("crash", crash.length() > 380 ? crash.substring(0, 380) : crash);
            JSONObject o = new JSONObject().put("room", prefs.code() + "T").put("kind", kind).put("vi", "tv " + Updater.current(this)).put("en", pack(x));
            String body = o.toString();
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
            aliveAt = android.os.SystemClock.elapsedRealtime();
            String cr = Crash.take(this);
            if (cr.isEmpty()) hello(); else tell("hello", cr);
            long lastSeq = -1;
            while (polling) {
                long wait = POLL_MS;
                alive();
                nr.sync(prefs.code());
                if (nr.listening()) {   /* the WebSocket brings every line: nothing to ask */
                    lastSeq = -1;
                    try { Thread.sleep(1500); } catch (InterruptedException ie) { nr.close(); return; }
                    continue;
                }
                try {
                    JSONObject j = fetch(Prefs.RELAY + prefs.code() + (lastSeq >= 0 ? "&since=" + lastSeq : "") + "&t=" + System.currentTimeMillis());
                    long seq = j.optLong("seq", 0);
                    Link.relayOkAt = Link.now();
                    if (lastSeq >= 0 && seq != lastSeq) Link.relayAt = Link.now();
                    if (lastSeq < 0) {
                        lastSeq = seq; // ignore whatever was there before this TV started listening
                    } else if (seq != lastSeq) {
                        // newer servers list every message after the last one seen: a subtitle and an area sent together both show
                        JSONArray items = j.optJSONArray("items");
                        if (items != null && items.length() > 0) {
                            for (int i = 0; i < items.length(); i++) {
                                JSONObject it = items.optJSONObject(i);
                                if (it != null && it.optLong("seq", 0) > lastSeq) handle(unpack(it));
                            }
                        } else handle(unpack(j));
                        lastSeq = seq;
                    }
                } catch (Exception e) {
                    Link.relayErrAt = Link.now();
                    wait = 2000;
                }
                try { Thread.sleep(wait); } catch (InterruptedException ie) { return; }
            }
        }, "hongsub-poll");
        poller.start();
    }

    /* honggame.store keeps only vi, en, who, size, pos, kind and mid: the computer packs the rest of a message into
       "en" as HSX1:<base64 JSON> (place over the original, colours, font, area boxes, heartbeat...) */
    static JSONObject unpack(JSONObject j) {
        String en = j.optString("en", "");
        if (!en.startsWith("HSX1:")) return j;
        try {
            JSONObject x = new JSONObject(new String(android.util.Base64.decode(en.substring(5), android.util.Base64.DEFAULT), "UTF-8"));
            j.put("en", x.optString("en", "")); x.remove("en");
            String k = x.optString("k", ""); if (!k.isEmpty()) { j.put("kind", k); x.remove("k"); }
            java.util.Iterator<String> it = x.keys();
            while (it.hasNext()) { String key = it.next(); j.put(key, x.get(key)); }
        } catch (Exception e) { try { j.put("en", ""); } catch (Exception ignored) { } }
        return j;
    }

    static String pack(JSONObject x) {
        try { return "HSX1:" + android.util.Base64.encodeToString(x.toString().getBytes("UTF-8"), android.util.Base64.NO_WRAP); } catch (Exception e) { return ""; }
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
