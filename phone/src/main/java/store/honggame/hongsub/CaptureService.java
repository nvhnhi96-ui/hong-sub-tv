package store.honggame.hongsub;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.Locale;

/**
 * Captures the screen (PS Remote Play running on this phone), reads the subtitle region with Gemini,
 * shows the Vietnamese line in a floating bubble, speaks it, and optionally pushes it to Hong Sub TV.
 */
public class CaptureService extends Service {
    static final String EXTRA_CODE = "code";
    static final String EXTRA_DATA = "data";
    static final String ACTION_STOP = "stop";
    static volatile boolean running;

    private static final int YELLOW = Color.rgb(255, 196, 0);
    private static final String RELAY = "https://honggame.store/wp-json/hgs-sub/v1/push";

    private Prefs prefs;
    private Gemini gem;
    private Groq groq;
    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread bgThread;
    private Handler bg;

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private int sw, sh, dpi, cw, ch;
    private Bitmap lastFrame;

    private WindowManager wm;
    private RegionView frame;
    private WindowManager.LayoutParams frameLp;
    private LinearLayout bubble;
    private WindowManager.LayoutParams bubbleLp;
    private TextView viTv, enTv;
    private LinearLayout bar;
    private WindowManager.LayoutParams barLp;
    private Button playBtn, editBtn;
    private View panel;

    private boolean translating = false;
    private boolean editing = false;
    private int[] lastSig, prevSig;
    // new-line detection on bright, text-like pixels only (a moving background no longer blocks lines)
    private static final int MW = 160, MH = 28;
    private Mask sentMask, prevMask;
    private long pendSince = 0;
    private final java.util.concurrent.atomic.AtomicInteger inflight = new java.util.concurrent.atomic.AtomicInteger();
    private final java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
    private int seq = 0, shownSeq = 0;
    private static final class Mask { byte[] m; int ink; }
    private String lastEn = "";
    private int darkTicks = 0;
    private final java.util.concurrent.ConcurrentLinkedDeque<String[]> history = new java.util.concurrent.ConcurrentLinkedDeque<>();

    private TextToSpeech tts;
    private boolean ttsReady;

    private final Runnable tick = this::tick;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = new Prefs(this);
        gem = new Gemini(prefs);
        groq = new Groq(prefs);
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        bgThread = new HandlerThread("hongsub-bg");
        bgThread.start();
        bg = new Handler(bgThread.getLooper());
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(new Locale("vi", "VN"));
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startAsForeground();
        if (projection != null || intent == null) return START_NOT_STICKY;
        int code = intent.getIntExtra(EXTRA_CODE, 0);
        Intent data = intent.getParcelableExtra(EXTRA_DATA);
        if (data == null) { stopSelf(); return START_NOT_STICKY; }
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        projection = mpm.getMediaProjection(code, data);
        if (projection == null) { stopSelf(); return START_NOT_STICKY; }
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { main.post(() -> stopSelf()); }
        }, main);
        running = true;
        setupDisplay();
        buildOverlays();
        bubbleText("", "Mở app PS Remote Play, rồi bấm Khung để kéo khung trùm lên phụ đề.", null, 9000);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        translating = false;
        bg.removeCallbacksAndMessages(null);
        pool.shutdownNow();
        main.removeCallbacksAndMessages(null);
        try { if (display != null) display.release(); } catch (Exception ignored) { }
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        try { if (projection != null) projection.stop(); } catch (Exception ignored) { }
        for (View v : new View[]{frame, bubble, bar, panel}) {
            if (v != null) try { wm.removeView(v); } catch (Exception ignored) { }
        }
        if (tts != null) tts.shutdown();
        bgThread.quitSafely();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- foreground

    private void startAsForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel("hongsub", "Hóng Sub", NotificationManager.IMPORTANCE_LOW));
            b = new Notification.Builder(this, "hongsub");
        } else {
            b = new Notification.Builder(this);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, CaptureService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = b.setContentTitle("Hóng Sub đang chạy")
                .setContentText("Đọc phụ đề trên màn hình để dịch sang tiếng Việt")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Tắt", stop).build())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(1, n);
        }
    }

    // ---------------------------------------------------------------- capture

    private void readMetrics() {
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        sw = dm.widthPixels;
        sh = dm.heightPixels;
        dpi = dm.densityDpi;
        float scale = Math.min(1f, 1280f / Math.max(sw, sh));
        cw = Math.max(2, Math.round(sw * scale));
        ch = Math.max(2, Math.round(sh * scale));
    }

    @SuppressLint("WrongConstant")
    private void setupDisplay() {
        readMetrics();
        reader = ImageReader.newInstance(cw, ch, PixelFormat.RGBA_8888, 2);
        display = projection.createVirtualDisplay("hongsub", cw, ch, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, bg);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        main.postDelayed(this::onRotate, 400);
    }

    @SuppressLint("WrongConstant")
    private void onRotate() {
        if (display == null) return;
        int oldW = sw, oldH = sh;
        readMetrics();
        if (oldW == sw && oldH == sh) return;
        bg.post(() -> {
            ImageReader old = reader;
            reader = ImageReader.newInstance(cw, ch, PixelFormat.RGBA_8888, 2);
            display.resize(cw, ch, dpi);
            display.setSurface(reader.getSurface());
            lastFrame = null;
            lastSig = null; sentMask = null; prevMask = null;
            prevSig = null;
            try { old.close(); } catch (Exception ignored) { }
        });
        placeFrame();
    }

    /** Latest full screen frame at capture resolution (cw x ch), or the previous one if nothing changed. */
    private Bitmap grab() {
        Image img = null;
        try {
            img = reader.acquireLatestImage();
            if (img == null) return lastFrame;
            Image.Plane p = img.getPlanes()[0];
            ByteBuffer buf = p.getBuffer();
            int pixelStride = p.getPixelStride();
            int rowStride = p.getRowStride();
            int w = img.getWidth(), h = img.getHeight();
            int padded = rowStride / pixelStride;
            Bitmap full = Bitmap.createBitmap(padded, h, Bitmap.Config.ARGB_8888);
            full.copyPixelsFromBuffer(buf);
            Bitmap out = padded == w ? full : Bitmap.createBitmap(full, 0, 0, w, h);
            lastFrame = out;
            return out;
        } catch (Exception e) {
            return lastFrame;
        } finally {
            if (img != null) img.close();
        }
    }

    private Bitmap crop(Bitmap full, float[] r) {
        int w = full.getWidth(), h = full.getHeight();
        int inset = Math.max(2, Math.round(6f * w / Math.max(1, sw)));
        int x = clamp(Math.round(r[0] * w) + inset, 0, w - 2);
        int y = clamp(Math.round(r[1] * h) + inset, 0, h - 2);
        int cwid = clamp(Math.round(r[2] * w) - 2 * inset, 2, w - x);
        int chei = clamp(Math.round(r[3] * h) - 2 * inset, 2, h - y);
        return Bitmap.createBitmap(full, x, y, cwid, chei);
    }

    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    private static int[] signature(Bitmap b) {
        Bitmap s = Bitmap.createScaledBitmap(b, 64, 16, true);
        int[] px = new int[64 * 16];
        s.getPixels(px, 0, 64, 0, 0, 64, 16);
        int[] out = new int[px.length];
        for (int i = 0; i < px.length; i++) {
            int c = px[i];
            out[i] = (((c >> 16) & 255) * 3 + ((c >> 8) & 255) * 6 + (c & 255)) / 10;
        }
        return out;
    }

    private static double diff(int[] a, int[] b) {
        if (a == null || b == null) return 255;
        long t = 0;
        for (int i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
        return (double) t / a.length;
    }

    private static Mask textMask(Bitmap b) {
        Bitmap s = Bitmap.createScaledBitmap(b, MW, MH, true);
        int[] px = new int[MW * MH];
        s.getPixels(px, 0, MW, 0, 0, MW, MH);
        Mask k = new Mask(); k.m = new byte[px.length];
        for (int i = 0; i < px.length; i++) {
            int c = px[i], r = (c >> 16) & 255, g = (c >> 8) & 255, bl = c & 255;
            double l = r * .3 + g * .59 + bl * .11;
            if (l > 175 || (r > 200 && g > 170 && bl < 120)) { k.m[i] = 1; k.ink++; }
        }
        return k;
    }

    private static double maskDiff(Mask a, Mask b) {
        if (a == null || b == null) return 1;
        int x = 0;
        for (int i = 0; i < a.m.length; i++) if (a.m[i] != b.m[i]) x++;
        return (double) x / Math.max(1, Math.max(a.ink, b.ink));
    }

    private static double mean(int[] a) {
        long t = 0;
        for (int v : a) t += v;
        return (double) t / a.length;
    }

    private static String jpeg(Bitmap b, int maxW, int q) {
        Bitmap s = b;
        if (b.getWidth() > maxW) s = Bitmap.createScaledBitmap(b, maxW, Math.max(1, b.getHeight() * maxW / b.getWidth()), true);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        s.compress(Bitmap.CompressFormat.JPEG, q, bo);
        return Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
    }

    // ---------------------------------------------------------------- translate loop

    private void tick() {
        if (!translating) return;
        long next = prefs.interval();
        try {
            Bitmap full = grab();
            if (full != null) {
                Bitmap region = crop(full, prefs.region());
                int[] s = signature(region);
                if (mean(signature(full)) < 3) {
                    if (++darkTicks == 12) {
                        bubbleText("", "Không đọc được hình. App PS Remote Play có thể đang chặn ghi màn hình, hoặc màn hình đang tối.", null, 9000);
                    }
                } else {
                    darkTicks = 0;
                }
                Mask m = textMask(region);
                long now = System.currentTimeMillis();
                Mask prev = prevMask; prevMask = m;
                if (m.ink < MW * MH * 0.004) {
                    pendSince = 0;                                  // no subtitle on screen
                } else if (sentMask != null && maskDiff(m, sentMask) < 0.22) {
                    pendSince = 0;                                  // same line as the one already sent
                } else if (inflight.get() < 2) {
                    boolean steady = prev != null && maskDiff(m, prev) < 0.08;
                    if (pendSince == 0) pendSince = now;
                    if (steady || now - pendSince > 900) {
                        sentMask = m; pendSince = 0;
                        final Bitmap copy = region.copy(Bitmap.Config.ARGB_8888, false);
                        final int my = ++seq;
                        inflight.incrementAndGet();
                        pool.submit(() -> {
                            try { translate(copy, my); }
                            catch (Gemini.CoolException ce) { setStatus("Mã tạm hết lượt, đang chờ..."); }
                            catch (Exception e) { setStatus("Lỗi: " + e.getMessage()); }
                            finally { inflight.decrementAndGet(); }
                        });
                    } else {
                        next = Math.min(next, 180);                  // line still appearing: look again soon
                    }
                }
            }
        } catch (Gemini.CoolException ce) {
            setStatus("Mã tạm hết lượt, đang chờ...");
            next = 3000;
        } catch (Exception e) {
            setStatus("Lỗi: " + e.getMessage());
            next = 2000;
        }
        if (translating) bg.postDelayed(tick, next);
    }

    private String context() {
        StringBuilder sb = new StringBuilder();
        if (!prefs.game().isEmpty()) sb.append("Game: ").append(prefs.game()).append('\n');
        if (!prefs.notes().isEmpty()) sb.append("Character / pronoun notes: ").append(prefs.notes()).append('\n');
        if (!history.isEmpty()) {
            sb.append("Recent lines (for consistency):\n");
            for (String[] h : history) sb.append(h[0]).append(" => ").append(h[1]).append('\n');
        }
        return sb.toString();
    }

    private static final String SHAPE_SUB = "{\"speaker\":\"\",\"en\":\"\",\"vi\":\"\"}";
    private static final String SHAPE_ALL = "{\"items\":[{\"en\":\"\",\"vi\":\"\"}]}";

    /** Gemini first; Groq when Gemini is out of quota or failing (or when only Groq keys exist). */
    private JSONObject ask(String prompt, String b64, JSONObject schema, String shape) throws Exception {
        if (!prefs.keys().isEmpty()) {
            try {
                return gem.ask(prompt, b64, schema);
            } catch (Exception e) {
                if (prefs.groqKeys().isEmpty()) throw e;
            }
        }
        if (!prefs.groqKeys().isEmpty()) return groq.ask(prompt, b64, shape);
        throw new Exception("Cần nhập mã Gemini hoặc Groq");
    }

    private void translate(Bitmap region, int mySeq) throws Exception {
        JSONObject schema = new JSONObject("{\"type\":\"OBJECT\",\"properties\":{\"speaker\":{\"type\":\"STRING\"},\"en\":{\"type\":\"STRING\"},\"vi\":{\"type\":\"STRING\"}},\"required\":[\"en\",\"vi\"]}");
        String prompt = "You translate video game subtitles for a Vietnamese player.\n"
                + "The image is a crop of the game screen where dialogue subtitles appear.\n"
                + "1. Copy ONLY the subtitle/dialogue text in English into \"en\", exactly as written. Ignore HUD, button prompts, icons and app overlays.\n"
                + "2. If the line starts with a speaker name and a colon (e.g. \"ATREUS: ...\"), keep that prefix at the start of \"en\". Never add a name that is not written on screen.\n"
                + "3. Translate the dialogue (without the speaker name) into natural spoken Vietnamese that fits game dialogue in \"vi\". Keep names of characters, places and items as they are. Pick Vietnamese pronouns that fit the relationship.\n"
                + "4. If there is no readable English subtitle, return \"en\":\"\" and \"vi\":\"\".\n" + context();
        JSONObject r = ask(prompt, jpeg(region, 900, 85), schema, SHAPE_SUB);
        if (r == null) return;
        String en = r.optString("en", "").trim();
        String vi = r.optString("vi", "").trim();
        String who = "";
        java.util.regex.Matcher sm = java.util.regex.Pattern.compile("^\\s*([A-Za-z][A-Za-z0-9 .'\\-]{0,24}?)\\s*[:：]\\s+([\\s\\S]+)$").matcher(en);
        if (sm.find() && !sm.group(1).matches("(?i)press|hold|tap|objective|quest|mission|tip|hint|note")) {
            who = sm.group(1).trim(); en = sm.group(2).trim();
            vi = vi.replaceFirst("(?i)^\\s*" + java.util.regex.Pattern.quote(who) + "\\s*[:：]\\s*", "");
        }
        synchronized (this) {
            if (en.isEmpty() || vi.isEmpty() || similar(en, lastEn)) return;
            if (mySeq < shownSeq) return;                         // an older line finished after a newer one
            shownSeq = mySeq;
            lastEn = en;
        }
        history.addFirst(new String[]{en, vi});
        while (history.size() > 3) history.removeLast();
        bubbleText(who, vi, en, Math.max(4500, Math.min(12000, vi.length() * 110L)));
        speak(vi);
        pushTv(vi, en, who);
    }

    private void fullScreen() {
        bg.post(() -> {
            try {
                Bitmap full = grab();
                if (full == null) return;
                setStatus("Đang dịch cả màn hình...");
                JSONObject schema = new JSONObject("{\"type\":\"OBJECT\",\"properties\":{\"items\":{\"type\":\"ARRAY\",\"items\":{\"type\":\"OBJECT\",\"properties\":{\"en\":{\"type\":\"STRING\"},\"vi\":{\"type\":\"STRING\"}},\"required\":[\"en\",\"vi\"]}}},\"required\":[\"items\"]}");
                JSONObject r = ask("Read all English text visible on this video game screen (menus, quest text, item descriptions, dialogue, tutorials). Group words that belong to the same line or paragraph. Ignore button glyphs, numbers-only labels and app overlays. Translate each into natural Vietnamese; keep names as they are.\n" + context(),
                        jpeg(full, 1280, 85), schema, SHAPE_ALL);
                JSONArray items = r != null ? r.optJSONArray("items") : null;
                main.post(() -> showPanel(items));
            } catch (Gemini.CoolException ce) {
                setStatus("Mã tạm hết lượt, thử lại sau ít giây.");
            } catch (Exception e) {
                setStatus("Lỗi: " + e.getMessage());
            }
        });
    }

    private static String norm(String s) { return s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim(); }

    private static boolean similar(String a, String b) {
        a = norm(a); b = norm(b);
        if (a.isEmpty() || b.isEmpty()) return false;
        if (a.equals(b)) return true;
        String[] A = a.split(" "), B = b.split(" ");
        int hit = 0;
        java.util.List<String> bl = java.util.Arrays.asList(B);
        for (String w : A) if (bl.contains(w)) hit++;
        return (double) hit / Math.max(A.length, B.length) > 0.85;
    }

    private void speak(String vi) {
        if (prefs.speak() && ttsReady) tts.speak(vi, TextToSpeech.QUEUE_FLUSH, null, "line");
    }

    private void pushTv(String vi, String en, String who) {
        String code = prefs.tv();
        if (code.length() < 4) return;
        try {
            JSONObject b = new JSONObject().put("room", code).put("vi", vi).put("en", en).put("who", who);
            Gemini.http("POST", RELAY, b.toString());
        } catch (Exception ignored) { }
    }

    // ---------------------------------------------------------------- overlays

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private WindowManager.LayoutParams overlayParams(int w, int h, boolean touchable) {
        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
        int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
        if (!touchable) flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(w, h, type, flags, PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        return lp;
    }

    private Button smallButton(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        b.setTextColor(Color.WHITE);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setPadding(dp(10), dp(6), dp(10), dp(6));
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(8));
        g.setColor(Color.rgb(36, 36, 44));
        b.setBackground(g);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.setMargins(dp(3), 0, dp(3), 0);
        b.setLayoutParams(p);
        return b;
    }

    @SuppressLint("ClickableViewAccessibility")
    private void buildOverlays() {
        // Region frame
        frame = new RegionView();
        frameLp = overlayParams(100, 100, false);
        wm.addView(frame, frameLp);
        placeFrame();

        // Subtitle bubble
        bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(dp(14), dp(8), dp(14), dp(10));
        GradientDrawable bg1 = new GradientDrawable();
        bg1.setCornerRadius(dp(12));
        bg1.setColor(Color.argb(225, 10, 10, 12));
        bg1.setStroke(dp(1), Color.argb(120, 255, 196, 0));
        bubble.setBackground(bg1);
        viTv = new TextView(this);
        viTv.setTextColor(Color.WHITE);
        viTv.setTypeface(Typeface.DEFAULT_BOLD);
        viTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        enTv = new TextView(this);
        enTv.setTextColor(Color.rgb(170, 170, 182));
        enTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        bubble.addView(viTv);
        bubble.addView(enTv);
        bubbleLp = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, true);
        bubbleLp.x = dp(16);
        bubbleLp.y = dp(24);
        bubble.setVisibility(View.GONE);
        wm.addView(bubble, bubbleLp);
        makeDraggable(bubble, bubbleLp);
        updateBubbleWidth();

        // Control bar
        bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(6), dp(6), dp(6));
        GradientDrawable bg2 = new GradientDrawable();
        bg2.setCornerRadius(dp(14));
        bg2.setColor(Color.argb(235, 16, 16, 20));
        bar.setBackground(bg2);
        TextView handle = new TextView(this);
        handle.setText(" H ");
        handle.setTextColor(Color.rgb(11, 11, 13));
        handle.setTypeface(Typeface.DEFAULT_BOLD);
        handle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        GradientDrawable hb = new GradientDrawable();
        hb.setCornerRadius(dp(8));
        hb.setColor(YELLOW);
        handle.setBackground(hb);
        handle.setPadding(dp(6), dp(4), dp(6), dp(4));
        bar.addView(handle);
        playBtn = smallButton("▶ Dịch", v -> toggleTranslate());
        editBtn = smallButton("Khung", v -> toggleEdit());
        Button fullBtn = smallButton("Cả màn", v -> fullScreen());
        Button closeBtn = smallButton("✕", v -> stopSelf());
        bar.addView(playBtn);
        bar.addView(editBtn);
        bar.addView(fullBtn);
        bar.addView(closeBtn);
        barLp = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, true);
        barLp.x = dp(8);
        barLp.y = sh / 2;
        wm.addView(bar, barLp);
        makeDraggable(handle, bar, barLp);
    }

    private void updateBubbleWidth() {
        int max = (int) (Math.min(sw, Math.max(sw, sh)) * 0.9);
        viTv.setMaxWidth(max);
        enTv.setMaxWidth(max);
    }

    private void makeDraggable(View v, WindowManager.LayoutParams lp) { makeDraggable(v, v, lp); }

    @SuppressLint("ClickableViewAccessibility")
    private void makeDraggable(View handle, View win, WindowManager.LayoutParams lp) {
        final float[] start = new float[4];
        handle.setOnTouchListener((view, e) -> {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    start[0] = e.getRawX(); start[1] = e.getRawY(); start[2] = lp.x; start[3] = lp.y;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    lp.x = (int) (start[2] + e.getRawX() - start[0]);
                    lp.y = (int) (start[3] + e.getRawY() - start[1]);
                    try { wm.updateViewLayout(win, lp); } catch (Exception ignored) { }
                    return true;
                default:
                    return true;
            }
        });
    }

    private void placeFrame() {
        if (frame == null) return;
        float[] r = prefs.region();
        frameLp.x = Math.round(r[0] * sw);
        frameLp.y = Math.round(r[1] * sh);
        frameLp.width = Math.max(dp(80), Math.round(r[2] * sw));
        frameLp.height = Math.max(dp(30), Math.round(r[3] * sh));
        try { wm.updateViewLayout(frame, frameLp); } catch (Exception ignored) { }
        frame.invalidate();
        updateBubbleWidth();
    }

    private void saveFrame() {
        prefs.region((float) frameLp.x / sw, (float) frameLp.y / sh, (float) frameLp.width / sw, (float) frameLp.height / sh);
        lastSig = null; sentMask = null; prevMask = null;
        prevSig = null;
    }

    private void toggleEdit() {
        editing = !editing;
        if (editing) {
            frameLp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            editBtn.setText("Xong");
            bubbleText("", "Kéo khung trùm lên dòng phụ đề. Kéo góc dưới bên phải để đổi cỡ. Xong bấm \"Xong\".", null, 8000);
        } else {
            frameLp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            editBtn.setText("Khung");
            saveFrame();
        }
        try { wm.updateViewLayout(frame, frameLp); } catch (Exception ignored) { }
        frame.invalidate();
    }

    private void toggleTranslate() {
        translating = !translating;
        playBtn.setText(translating ? "⏸ Dừng" : "▶ Dịch");
        if (translating) {
            if (editing) toggleEdit();
            if (prefs.keys().isEmpty() && prefs.groqKeys().isEmpty()) {
                translating = false;
                playBtn.setText("▶ Dịch");
                bubbleText("", "Chưa có mã Gemini. Mở app Hóng Sub để nhập mã.", null, 6000);
                return;
            }
            lastSig = null; sentMask = null; prevMask = null;
            prevSig = null;
            darkTicks = 0;
            bg.removeCallbacks(tick);
            bg.post(tick);
            bubbleText("", "Đang chờ phụ đề...", null, 2500);
        } else {
            bg.removeCallbacks(tick);
        }
        frame.invalidate();
    }

    private final Runnable hideBubble = () -> { if (bubble != null) bubble.setVisibility(View.GONE); };

    private void bubbleText(String who, String vi, String en, long holdMs) {
        main.post(() -> {
            if (bubble == null) return;
            SpannableStringBuilder sb = new SpannableStringBuilder();
            if (who != null && !who.isEmpty()) {
                sb.append(who).append(": ");
                sb.setSpan(new ForegroundColorSpan(YELLOW), 0, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            sb.append(vi);
            viTv.setText(sb);
            boolean showEn = prefs.showEn() && en != null && !en.isEmpty();
            enTv.setText(showEn ? en : "");
            enTv.setVisibility(showEn ? View.VISIBLE : View.GONE);
            bubble.setVisibility(View.VISIBLE);
            main.removeCallbacks(hideBubble);
            main.postDelayed(hideBubble, holdMs);
        });
    }

    private void setStatus(String s) { bubbleText("", s, null, 4000); }

    private void showPanel(JSONArray items) {
        if (panel != null) { try { wm.removeView(panel); } catch (Exception ignored) { } panel = null; }
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(14));
        g.setColor(Color.argb(240, 16, 16, 20));
        box.setBackground(g);
        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView t = new TextView(this);
        t.setText("Dịch cả màn hình");
        t.setTextColor(YELLOW);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        head.addView(t, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        head.addView(smallButton("Đóng", v -> { try { wm.removeView(panel); } catch (Exception ignored) { } panel = null; }));
        box.addView(head);
        ScrollView sv = new ScrollView(this);
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        sv.addView(list);
        if (items == null || items.length() == 0) {
            TextView e = new TextView(this);
            e.setText("Không thấy chữ tiếng Anh trên màn hình.");
            e.setTextColor(Color.WHITE);
            list.addView(e);
        } else {
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                TextView vi = new TextView(this);
                vi.setText(it.optString("vi"));
                vi.setTextColor(Color.WHITE);
                vi.setTypeface(Typeface.DEFAULT_BOLD);
                vi.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
                vi.setPadding(0, dp(8), 0, 0);
                TextView en = new TextView(this);
                en.setText(it.optString("en"));
                en.setTextColor(Color.rgb(160, 160, 172));
                en.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                list.addView(vi);
                list.addView(en);
            }
        }
        box.addView(sv, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        WindowManager.LayoutParams lp = overlayParams((int) (sw * 0.86), (int) (sh * 0.7), true);
        lp.x = (int) (sw * 0.07);
        lp.y = (int) (sh * 0.12);
        panel = box;
        wm.addView(panel, lp);
    }

    /** Dashed yellow rectangle marking the subtitle region; movable and resizable while editing. */
    private class RegionView extends View {
        private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint label = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float downX, downY;
        private int startX, startY, startW, startH;
        private boolean resizing;

        RegionView() {
            super(CaptureService.this);
            line.setStyle(Paint.Style.STROKE);
            line.setColor(YELLOW);
            label.setColor(YELLOW);
            label.setTypeface(Typeface.DEFAULT_BOLD);
            label.setTextSize(dp(11));
            fill.setColor(YELLOW);
        }

        @Override
        protected void onDraw(Canvas c) {
            int w = getWidth(), h = getHeight();
            if (editing) {
                line.setStrokeWidth(dp(3));
                line.setPathEffect(new DashPathEffect(new float[]{dp(10), dp(6)}, 0));
                line.setAlpha(255);
                c.drawRect(dp(2), dp(2), w - dp(2), h - dp(2), line);
                c.drawCircle(w - dp(12), h - dp(12), dp(10), fill);
                c.drawText("Khung phụ đề", dp(8), dp(16), label);
            } else {
                line.setStrokeWidth(dp(1.5f));
                line.setPathEffect(new DashPathEffect(new float[]{dp(6), dp(6)}, 0));
                line.setAlpha(translating ? 110 : 180);
                c.drawRect(dp(1), dp(1), w - dp(1), h - dp(1), line);
            }
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouchEvent(MotionEvent e) {
            if (!editing) return false;
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX(); downY = e.getRawY();
                    startX = frameLp.x; startY = frameLp.y; startW = frameLp.width; startH = frameLp.height;
                    resizing = e.getX() > getWidth() - dp(48) && e.getY() > getHeight() - dp(48);
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                    if (resizing) {
                        frameLp.width = Math.max(dp(80), (int) (startW + dx));
                        frameLp.height = Math.max(dp(30), (int) (startH + dy));
                    } else {
                        frameLp.x = (int) (startX + dx);
                        frameLp.y = (int) (startY + dy);
                    }
                    try { wm.updateViewLayout(this, frameLp); } catch (Exception ignored) { }
                    invalidate();
                    return true;
                case MotionEvent.ACTION_UP:
                    saveFrame();
                    return true;
                default:
                    return true;
            }
        }
    }
}
