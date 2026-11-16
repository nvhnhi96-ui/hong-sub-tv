package store.honggame.hongsub;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
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
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Screen recording for the Hóng Sub page, and everything drawn over the game:
 * the Vietnamese subtitle (also right over the original one), extra areas, whole-screen translation,
 * the floating "H" button with its menu, and the frame drawn around the subtitle with a finger.
 */
public class CaptureService extends Service {
    static final String EXTRA_CODE = "code", EXTRA_DATA = "data", ACTION_STOP = "stop";
    static volatile boolean running = false;
    private static CaptureService self;
    private static final int YELLOW = Color.rgb(255, 196, 0);

    // ------------------------------------------------------------ pictures for the page

    static final class Frame { final int seq; final byte[] jpeg; Frame(int s, byte[] j) { seq = s; jpeg = j; } }
    private static final Object lock = new Object();
    private static Frame last = null;
    private static int seq = 0;
    private static volatile boolean appFront = false;
    private static volatile long ignoreUntil = 0;

    /** Hóng Sub itself in front: keep the last game picture (so the frame can be drawn on it in the app) */
    static void front(boolean on) {
        appFront = on;
        if (!on) ignoreUntil = System.currentTimeMillis() + 700;   // the switch animation is not the game
        CaptureService s = self;
        if (s != null) s.main.post(s::showOverlays);
    }

    /** the newest picture after "after", or null when there is nothing new */
    static Frame frame(int after) {
        CaptureService s = self;
        synchronized (lock) {
            if (s != null && s.reader != null) {
                Image img = null;
                try {
                    img = s.reader.acquireLatestImage();
                    if (img != null && !appFront && System.currentTimeMillis() > ignoreUntil) {
                        byte[] j = toJpeg(img);
                        if (j != null) last = new Frame(++seq, j);
                    }
                } catch (Exception ignored) {
                } finally { if (img != null) img.close(); }
            }
            return last != null && last.seq > after ? last : null;
        }
    }

    private static byte[] toJpeg(Image img) {
        Image.Plane p = img.getPlanes()[0];
        ByteBuffer buf = p.getBuffer();
        int w = img.getWidth(), h = img.getHeight(), padded = p.getRowStride() / p.getPixelStride();
        Bitmap full = Bitmap.createBitmap(padded, h, Bitmap.Config.ARGB_8888);
        full.copyPixelsFromBuffer(buf);
        Bitmap out = padded == w ? full : Bitmap.createBitmap(full, 0, 0, w, h);
        ByteArrayOutputStream o = new ByteArrayOutputStream(256 * 1024);
        out.compress(Bitmap.CompressFormat.JPEG, 85, o);
        if (out != full) out.recycle();
        full.recycle();
        return o.toByteArray();
    }

    /** from the page (any thread) */
    static void post(String kind, String json) {
        CaptureService s = self;
        if (s == null) return;
        s.main.post(() -> {
            try {
                Object o = json == null || json.equals("null") ? null : new org.json.JSONTokener(json).nextValue();
                switch (kind) {
                    case "sub": s.sub(o instanceof JSONObject ? (JSONObject) o : null); break;
                    case "place": s.place = o instanceof JSONObject ? (JSONObject) o : null; s.styleSub(); break;
                    case "zones": s.zones(o instanceof JSONArray ? (JSONArray) o : null); break;
                    case "full": s.full(o instanceof JSONObject ? (JSONObject) o : null); break;
                    case "state": s.state(o instanceof JSONObject ? (JSONObject) o : null); break;
                }
            } catch (Exception ignored) { }
        });
    }

    static void announce() { CaptureService s = self; if (s != null) MainActivity.event("capture", "{\"w\":" + s.cw + ",\"h\":" + s.ch + "}"); }

    // ------------------------------------------------------------ service

    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread bgThread;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private int sw, sh, dpi, cw, ch;
    private WindowManager wm;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        bgThread = new HandlerThread("hongsub-capture");
        bgThread.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        foreground();
        if (projection != null || intent == null) return START_NOT_STICKY;
        Intent data = intent.getParcelableExtra(EXTRA_DATA);
        if (data == null) { stopSelf(); return START_NOT_STICKY; }
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        try { projection = mpm.getMediaProjection(intent.getIntExtra(EXTRA_CODE, 0), data); } catch (Exception e) { projection = null; }
        if (projection == null) { stopSelf(); return START_NOT_STICKY; }
        projection.registerCallback(new MediaProjection.Callback() { @Override public void onStop() { main.post(() -> stopSelf()); } }, main);
        self = this; running = true;
        setupDisplay();
        buildOverlays();
        announce();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (self == this) self = null;
        MainActivity.event("stopped", "{}");
        main.removeCallbacksAndMessages(null);
        for (View v : new View[]{subBox, layer, bubble, menu, editor}) if (v != null) try { wm.removeView(v); } catch (Exception ignored) { }
        try { if (display != null) display.release(); } catch (Exception ignored) { }
        synchronized (lock) { try { if (reader != null) reader.close(); } catch (Exception ignored) { } reader = null; last = null; }
        try { if (projection != null) projection.stop(); } catch (Exception ignored) { }
        bgThread.quitSafely();
        super.onDestroy();
    }

    private void foreground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) { nm.createNotificationChannel(new NotificationChannel("hongsub", "Hóng Sub", NotificationManager.IMPORTANCE_LOW)); b = new Notification.Builder(this, "hongsub"); }
        else b = new Notification.Builder(this);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, CaptureService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = b.setContentTitle("Hóng Sub đang dịch phụ đề").setContentText("Bấm nút H nổi trên màn hình để điều khiển")
                .setSmallIcon(android.R.drawable.ic_menu_view).setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Tắt", stop).build()).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(1, n);
    }

    private void readMetrics() {
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        sw = dm.widthPixels; sh = dm.heightPixels; dpi = dm.densityDpi;
        float sc = Math.min(1f, 1920f / Math.max(sw, sh));   // sharp enough for small text, light enough to send several times a second
        cw = Math.max(2, Math.round(sw * sc)); ch = Math.max(2, Math.round(sh * sc));
    }

    @SuppressLint("WrongConstant")
    private void setupDisplay() {
        readMetrics();
        reader = ImageReader.newInstance(cw, ch, PixelFormat.RGBA_8888, 2);
        display = projection.createVirtualDisplay("hongsub", cw, ch, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, new Handler(bgThread.getLooper()));
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        main.postDelayed(this::onRotate, 400);
    }

    @SuppressLint("WrongConstant")
    private void onRotate() {
        if (display == null) return;
        int ow = sw, oh = sh;
        readMetrics();
        if (ow == sw && oh == sh) return;
        synchronized (lock) {
            ImageReader old = reader;
            reader = ImageReader.newInstance(cw, ch, PixelFormat.RGBA_8888, 2);
            display.resize(cw, ch, dpi);
            display.setSurface(reader.getSurface());
            try { old.close(); } catch (Exception ignored) { }
        }
        announce();
        styleSub(); drawZones(); drawFull(); placeMenu();
    }

    // ------------------------------------------------------------ drawing over the game

    private LinearLayout subBox; private TextView subVi, subEn; private WindowManager.LayoutParams subLp;
    private FrameLayout layer;
    private final FrameLayout[] groups = new FrameLayout[2];   // 0 = extra areas, 1 = whole screen
    private TextView bubble; private WindowManager.LayoutParams bubbleLp;
    private LinearLayout menu; private WindowManager.LayoutParams menuLp;
    private RegionEditor editor;
    private JSONObject style = new JSONObject(), place = null, st = new JSONObject();
    private JSONArray zoneData = null; private JSONObject fullData = null;
    private Button bRun, bSpeak, bFull;

    private int dp(float v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics())); }
    private int type() { return Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE; }
    private WindowManager.LayoutParams lp(int w, int h, boolean touch) {
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(w, h, type(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | (touch ? 0 : WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE), PixelFormat.TRANSLUCENT);
        if (Build.VERSION.SDK_INT >= 28) p.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        return p;
    }
    /** text size: the same number as on the computer, scaled to this screen */
    private float px(double size) { return (float) (size * Math.min(sw, sh) / 1080.0 * 1.7); }
    private Typeface face(String k) {
        if ("notoserif".equals(k)) return Typeface.create(Typeface.SERIF, Typeface.BOLD);
        if ("oswald".equals(k)) return Typeface.create("sans-serif-condensed", Typeface.BOLD);
        if ("quicksand".equals(k) || "nunito".equals(k)) return Typeface.create("sans-serif-medium", Typeface.BOLD);
        return Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD);
    }

    private void buildOverlays() {
        // whole-screen and area translations (under the subtitle)
        layer = new FrameLayout(this);
        for (int i = 0; i < 2; i++) { groups[i] = new FrameLayout(this); layer.addView(groups[i], new FrameLayout.LayoutParams(-1, -1)); }
        wm.addView(layer, lp(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, false));
        // the subtitle
        subBox = new LinearLayout(this); subBox.setOrientation(LinearLayout.VERTICAL); subBox.setGravity(Gravity.CENTER_HORIZONTAL);
        subBox.setPadding(dp(12), dp(6), dp(12), dp(7));
        subVi = new TextView(this); subVi.setTextColor(Color.WHITE); subVi.setGravity(Gravity.CENTER); subVi.setShadowLayer(4, 0, 2, Color.argb(160, 0, 0, 0));
        subEn = new TextView(this); subEn.setTextColor(Color.rgb(190, 196, 206)); subEn.setGravity(Gravity.CENTER);
        subBox.addView(subVi); subBox.addView(subEn);
        subBox.setVisibility(View.GONE);
        subLp = lp(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, false);
        wm.addView(subBox, subLp);
        // the floating button
        bubble = new TextView(this); bubble.setText("H"); bubble.setTextColor(Color.rgb(20, 16, 0)); bubble.setTypeface(Typeface.DEFAULT_BOLD);
        bubble.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20); bubble.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable(); bg.setShape(GradientDrawable.OVAL); bg.setColor(YELLOW); bg.setStroke(dp(2), Color.argb(200, 0, 0, 0)); bubble.setBackground(bg);
        bubbleLp = lp(dp(48), dp(48), true); bubbleLp.gravity = Gravity.TOP | Gravity.LEFT;
        bubbleLp.x = getSharedPreferences("hs", MODE_PRIVATE).getInt("bx", dp(8)); bubbleLp.y = getSharedPreferences("hs", MODE_PRIVATE).getInt("by", dp(120));
        drag(bubble, bubbleLp, this::toggleMenu);
        wm.addView(bubble, bubbleLp);
        // its menu
        menu = new LinearLayout(this); menu.setOrientation(LinearLayout.VERTICAL); menu.setPadding(dp(8), dp(8), dp(8), dp(8));
        GradientDrawable mb = new GradientDrawable(); mb.setColor(Color.argb(240, 22, 24, 29)); mb.setCornerRadius(dp(14)); mb.setStroke(dp(1), Color.argb(80, 255, 255, 255)); menu.setBackground(mb);
        bRun = item("Bắt đầu dịch", v -> cmd("toggle"));
        item("Dịch ngay câu này", v -> cmd("now"));
        item("Khung phụ đề", v -> { hideMenu(); editRegion(); });
        item("Dịch các vùng", v -> cmd("zones"));
        bFull = item("Dịch cả màn hình", v -> { cmd("full"); hideMenu(); });
        bSpeak = item("Đọc to: bật", v -> cmd("speak"));
        item("Mở Hóng Sub", v -> { hideMenu(); MainActivity.bringToFront(this); });
        item("Tắt Hóng Sub", v -> stopSelf());
        menu.setVisibility(View.GONE);
        menuLp = lp(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, true); menuLp.gravity = Gravity.TOP | Gravity.LEFT;
        wm.addView(menu, menuLp);
        styleSub(); showOverlays();
    }

    private Button item(String label, View.OnClickListener l) {
        Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextColor(Color.WHITE); b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        b.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); b.setMinHeight(dp(40)); b.setMinimumHeight(dp(40)); b.setPadding(dp(12), 0, dp(16), 0);
        GradientDrawable d = new GradientDrawable(); d.setColor(Color.argb(255, 36, 39, 46)); d.setCornerRadius(dp(10)); b.setBackground(d);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(210), dp(42)); p.topMargin = dp(3); p.bottomMargin = dp(3);
        menu.addView(b, p);
        return b;
    }

    private void cmd(String k) { MainActivity.event("cmd", "{\"k\":\"" + k + "\"}"); }
    private void toggleMenu() { if (menu.getVisibility() == View.VISIBLE) hideMenu(); else { placeMenu(); menu.setVisibility(View.VISIBLE); } }
    private void hideMenu() { if (menu != null) menu.setVisibility(View.GONE); }
    private void placeMenu() {
        if (menu == null) return;
        menuLp.x = bubbleLp.x + dp(54) + dp(210) > sw ? Math.max(0, bubbleLp.x - dp(226)) : bubbleLp.x + dp(54);
        menuLp.y = Math.max(0, Math.min(sh - dp(420), bubbleLp.y - dp(20)));
        try { wm.updateViewLayout(menu, menuLp); } catch (Exception ignored) { }
    }

    @SuppressLint("ClickableViewAccessibility")
    private void drag(View v, WindowManager.LayoutParams p, Runnable tap) {
        final float[] s = new float[4]; final boolean[] moved = {false};
        v.setOnTouchListener((view, e) -> {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: s[0] = e.getRawX(); s[1] = e.getRawY(); s[2] = p.x; s[3] = p.y; moved[0] = false; return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = e.getRawX() - s[0], dy = e.getRawY() - s[1];
                    if (Math.abs(dx) + Math.abs(dy) > dp(6)) moved[0] = true;
                    p.x = (int) (s[2] + dx); p.y = (int) (s[3] + dy);
                    try { wm.updateViewLayout(v, p); } catch (Exception ignored) { }
                    if (menu.getVisibility() == View.VISIBLE) placeMenu();
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!moved[0]) tap.run();
                    else getSharedPreferences("hs", MODE_PRIVATE).edit().putInt("bx", p.x).putInt("by", p.y).apply();
                    return true;
            }
            return false;
        });
    }

    /** nothing over Hóng Sub itself; everything back over the game */
    private void showOverlays() {
        int vis = appFront ? View.GONE : View.VISIBLE;
        if (layer != null) layer.setVisibility(vis);
        if (bubble != null) bubble.setVisibility(vis);
        if (appFront) hideMenu();
        if (subBox != null && appFront) subBox.setVisibility(View.GONE);
        if (editor != null && appFront) closeEditor();
    }

    private void state(JSONObject j) {
        if (j == null) return;
        st = j;
        if (bRun != null) bRun.setText(j.optBoolean("running") ? "Dừng dịch" : "Bắt đầu dịch");
        if (bSpeak != null) bSpeak.setText(j.optBoolean("speak", true) ? "Đọc to: bật" : "Đọc to: tắt");
        if (bFull != null) bFull.setText(j.optBoolean("fs") ? "Tắt dịch cả màn hình" : "Dịch cả màn hình");
        GradientDrawable bg = (GradientDrawable) bubble.getBackground();
        bg.setColor(j.optBoolean("running") ? Color.rgb(61, 220, 132) : YELLOW);
    }

    private final Runnable subHide = () -> { if (subBox != null) subBox.setVisibility(View.GONE); };

    private void sub(JSONObject j) {
        if (j == null) return;
        style = j;
        String vi = j.optString("vi", "").trim();
        main.removeCallbacks(subHide);
        if (vi.isEmpty()) { subBox.setVisibility(View.GONE); return; }
        String who = j.optString("who", "").trim();
        SpannableStringBuilder sb = new SpannableStringBuilder();
        if (!who.isEmpty()) {
            sb.append(who).append(": ");
            int c = YELLOW; try { if (j.optString("c", "").startsWith("#")) c = Color.parseColor(j.optString("c")); } catch (Exception ignored) { }
            sb.setSpan(new ForegroundColorSpan(c), 0, who.length() + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        sb.append(vi);
        subVi.setText(sb);
        String en = j.optString("en", "");
        subEn.setText(en); subEn.setVisibility(en.isEmpty() ? View.GONE : View.VISIBLE);
        styleSub();
        if (!appFront) subBox.setVisibility(View.VISIBLE);
        int hold = j.optInt("hold", 0);
        main.postDelayed(subHide, hold > 0 ? hold * 1000L : 20000L);
    }

    /** size, colour, background and width chosen in Hóng Sub; over the original subtitle when "Đè chữ Việt" is on */
    private void styleSub() {
        if (subBox == null) return;
        double size = style.optDouble("size", 28);
        subVi.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(size));
        subEn.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(size) * 0.6f);
        int col = Color.WHITE; try { col = Color.parseColor(style.optString("col", "#FFFFFF")); } catch (Exception ignored) { }
        subVi.setTextColor(col);
        subVi.setTypeface(face(style.optString("font", "bevn")));
        GradientDrawable d = new GradientDrawable(); d.setCornerRadius(dp(place != null ? 4 : 10));
        d.setColor(Color.argb((int) Math.round(style.optDouble("bg", 74) * 2.55), 8, 9, 12));
        subBox.setBackground(d);
        int wid = (int) (style.optDouble("wid", 80) / 100.0 * sw);
        subVi.setMaxWidth(wid - dp(24)); subEn.setMaxWidth(wid - dp(24));
        if (place != null) {
            int bw = Math.max(dp(120), wid);
            int cx = (int) ((place.optDouble("x") + place.optDouble("w") / 2) * sw);
            subLp.gravity = Gravity.TOP | Gravity.LEFT; subLp.width = bw; subLp.height = WindowManager.LayoutParams.WRAP_CONTENT;
            subLp.x = Math.max(0, Math.min(sw - bw, cx - bw / 2)); subLp.y = (int) (place.optDouble("y") * sh);
            subBox.setMinimumHeight((int) (place.optDouble("h") * sh));
            subBox.setGravity(Gravity.CENTER);
        } else {
            subLp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL; subLp.width = WindowManager.LayoutParams.WRAP_CONTENT; subLp.height = WindowManager.LayoutParams.WRAP_CONTENT;
            subLp.x = 0; subLp.y = dp(18); subBox.setMinimumHeight(0); subBox.setGravity(Gravity.CENTER_HORIZONTAL);
        }
        try { wm.updateViewLayout(subBox, subLp); } catch (Exception ignored) { }
    }

    private void zones(JSONArray a) { zoneData = a; drawZones(); }
    private void full(JSONObject j) { fullData = j; drawFull(); }

    private TextView box(FrameLayout g, double x, double y, double w, double h, String text, double maxPx, int bgAlpha, String font) {
        TextView t = new TextView(this);
        t.setText(text); t.setTextColor(Color.WHITE); t.setGravity(Gravity.CENTER_VERTICAL | Gravity.START); t.setPadding(dp(4), dp(2), dp(4), dp(2));
        t.setTypeface(face(font));
        GradientDrawable d = new GradientDrawable(); d.setColor(Color.argb(bgAlpha, 8, 9, 12)); d.setCornerRadius(dp(4)); t.setBackground(d);
        int min = Math.max(6, (int) Math.min(maxPx, dp(9)));
        if (Build.VERSION.SDK_INT >= 26) t.setAutoSizeTextTypeUniformWithConfiguration(min, Math.max(min + 1, (int) maxPx), 1, TypedValue.COMPLEX_UNIT_PX);
        else t.setTextSize(TypedValue.COMPLEX_UNIT_PX, (float) maxPx);
        FrameLayout.LayoutParams p = new FrameLayout.LayoutParams((int) Math.max(dp(30), w * sw), (int) Math.max(dp(16), h * sh));
        int[] at = new int[2]; layer.getLocationOnScreen(at);   // the layer may start below the status bar
        p.leftMargin = (int) (x * sw) - at[0]; p.topMargin = (int) (y * sh) - at[1];
        g.addView(t, p);
        return t;
    }

    private void drawZones() {
        if (groups[0] == null) return;
        groups[0].removeAllViews();
        if (zoneData == null) return;
        for (int i = 0; i < zoneData.length(); i++) {
            JSONObject z = zoneData.optJSONObject(i); if (z == null) continue;
            String vi = z.optString("vi", ""); if (vi.isEmpty()) continue;
            box(groups[0], z.optDouble("x"), z.optDouble("y"), z.optDouble("w"), z.optDouble("h"), vi, px(z.optDouble("size", 17)), (int) Math.round(z.optDouble("bg", 90) * 2.55), z.optString("font", "bevn"));
        }
    }

    private void drawFull() {
        if (groups[1] == null) return;
        groups[1].removeAllViews();
        if (fullData == null) return;
        JSONArray it = fullData.optJSONArray("items"); if (it == null) return;
        for (int i = 0; i < it.length(); i++) {
            JSONObject b = it.optJSONObject(i); if (b == null) continue;
            box(groups[1], b.optDouble("x"), b.optDouble("y"), b.optDouble("w"), b.optDouble("h"), b.optString("vi", ""), Math.max(dp(10), b.optDouble("lh", 0.03) * sh * 0.8), 235, fullData.optString("font", "bevn"));
        }
    }

    // ------------------------------------------------------------ drawing the subtitle frame with a finger

    private void editRegion() {
        if (editor != null) return;
        editor = new RegionEditor(this);
        WindowManager.LayoutParams p = lp(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, true);
        wm.addView(editor, p);
    }
    private void closeEditor() { if (editor != null) { try { wm.removeView(editor); } catch (Exception ignored) { } editor = null; } }

    private final class RegionEditor extends FrameLayout {
        private final Paint dim = new Paint(), line = new Paint(Paint.ANTI_ALIAS_FLAG), hint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float x0, y0, x1, y1; private boolean has = false;
        RegionEditor(Context c) {
            super(c);
            setWillNotDraw(false);
            dim.setColor(Color.argb(110, 0, 0, 0));
            line.setStyle(Paint.Style.STROKE); line.setStrokeWidth(dp(3)); line.setColor(YELLOW);
            hint.setColor(Color.WHITE); hint.setTextSize(dp(17)); hint.setTextAlign(Paint.Align.CENTER); hint.setShadowLayer(4, 0, 2, Color.BLACK); hint.setFakeBoldText(true);
            LinearLayout bar = new LinearLayout(c); bar.setGravity(Gravity.CENTER);
            Button ok = btn("Xong", v -> done()), no = btn("Huỷ", v -> closeEditor());
            bar.addView(no); bar.addView(ok);
            LayoutParams p = new LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL); p.topMargin = dp(16);
            addView(bar, p);
        }
        private Button btn(String t, OnClickListener l) {
            Button b = new Button(getContext()); b.setText(t); b.setAllCaps(false); b.setTextColor(t.equals("Xong") ? Color.rgb(20, 16, 0) : Color.WHITE);
            GradientDrawable d = new GradientDrawable(); d.setColor(t.equals("Xong") ? YELLOW : Color.rgb(36, 39, 46)); d.setCornerRadius(dp(10)); b.setBackground(d);
            b.setOnClickListener(l);
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(110), dp(44)); p.leftMargin = dp(6); p.rightMargin = dp(6); b.setLayoutParams(p);
            return b;
        }
        @SuppressLint("ClickableViewAccessibility")
        @Override public boolean onTouchEvent(MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: x0 = x1 = e.getX(); y0 = y1 = e.getY(); has = true; invalidate(); return true;
                case MotionEvent.ACTION_MOVE: case MotionEvent.ACTION_UP: x1 = e.getX(); y1 = e.getY(); invalidate(); return true;
            }
            return super.onTouchEvent(e);
        }
        @Override protected void onDraw(Canvas c) {
            c.drawRect(0, 0, getWidth(), getHeight(), dim);
            if (has) c.drawRect(new RectF(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)), line);
            else c.drawText("Kéo ngón tay quanh dòng phụ đề của game", getWidth() / 2f, getHeight() / 2f, hint);
        }
        private void done() {
            if (!has || Math.abs(x1 - x0) < dp(30) || Math.abs(y1 - y0) < dp(12)) { closeEditor(); return; }
            int[] at = new int[2]; getLocationOnScreen(at);   // as parts of the whole screen, like the recorded picture
            float W = sw, H = sh;
            MainActivity.event("region", "{\"x\":" + (Math.min(x0, x1) + at[0]) / W + ",\"y\":" + (Math.min(y0, y1) + at[1]) / H + ",\"w\":" + Math.abs(x1 - x0) / W + ",\"h\":" + Math.abs(y1 - y0) / H + "}");
            closeEditor();
        }
    }

}
