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
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
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
    private Prefs prefs;
    private volatile boolean polling;
    private Thread poller;
    private TextToSpeech tts;
    private boolean ttsReady;
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
            }
        });
        startPolling();
        showLine("", "Hóng Sub TV đang chờ phụ đề · Mã " + prefs.code(), null, 6000, false);
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
        if (poller != null) poller.interrupt();
        main.removeCallbacksAndMessages(null);
        if (box != null && wm != null) {
            try { wm.removeView(box); } catch (Exception ignored) { }
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
        wm.addView(box, lp);
    }

    private void applyStyle() {
        if (box == null) return;
        int size = prefs.textSize();
        viView.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        enView.setTextSize(TypedValue.COMPLEX_UNIT_SP, Math.max(14, size * 0.55f));
        int screenW = getResources().getDisplayMetrics().widthPixels;
        viView.setMaxWidth((int) (screenW * 0.86));
        enView.setMaxWidth((int) (screenW * 0.86));
        lp.gravity = (prefs.top() ? Gravity.TOP : Gravity.BOTTOM) | Gravity.CENTER_HORIZONTAL;
        lp.y = dp(prefs.top() ? 36 : 46);
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
            if (speakIt && prefs.speak() && ttsReady) {
                tts.speak(vi, TextToSpeech.QUEUE_FLUSH, null, "line");
            }
        });
    }

    private void startPolling() {
        polling = true;
        poller = new Thread(() -> {
            long lastSeq = -1;
            while (polling) {
                long wait = POLL_MS;
                try {
                    JSONObject j = fetch(Prefs.RELAY + prefs.code() + "&t=" + System.currentTimeMillis());
                    long seq = j.optLong("seq", 0);
                    if (lastSeq < 0) {
                        lastSeq = seq; // ignore whatever was there before this TV started listening
                    } else if (seq != lastSeq) {
                        lastSeq = seq;
                        String vi = j.optString("vi", "");
                        if (!vi.isEmpty()) {
                            long hold = Math.max(4500, Math.min(12000, vi.length() * 110L));
                            showLine(j.optString("who", ""), vi, j.optString("en", ""), hold, true);
                        }
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
