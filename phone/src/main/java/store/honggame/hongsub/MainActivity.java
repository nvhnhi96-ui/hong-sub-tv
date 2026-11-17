package store.honggame.hongsub;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;

/**
 * Hóng Sub for Android phones: the very same Hóng Sub page as the Windows app and honggame.store/hong-sub
 * (same settings, shared translation store, voices, TV, extra areas, whole-screen translate), shown in a WebView.
 * The phone lends what a browser cannot do here: screen recording (pictures of PS Remote Play), Vietnamese text floating
 * over the game, the phone's voices and the floating "H" button. See Bridge for what the page can ask.
 */
public class MainActivity extends Activity {
    static final String BASE = "https://honggame.store/hong-sub/";
    private static final int REQ_CAPTURE = 7, REQ_NOTIF = 3, REQ_CAM = 9;
    private PermissionRequest camAsk = null;   // the page asked for the camera; waiting for Android's answer
    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean wantCapture = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        current = new WeakReference<>(this);
        getWindow().setStatusBarColor(Color.rgb(16, 18, 22));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Voice.init(this);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(16, 18, 22));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);       // the Google voice plays without a tap
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);   // the TV on the home network is plain http
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= 26) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);   // keeps working behind PS Remote Play
        web.addJavascriptInterface(new Bridge(), "HSPhone");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) { return true; }
            /* the camera ("Camera chĩa vào TV") and the microphone ("Dịch lời nhân vật nói" listening to the TV):
               the page asks, Android asks the person once */
            @Override public void onPermissionRequest(PermissionRequest r) {
                main.post(() -> {
                    java.util.ArrayList<String> want = new java.util.ArrayList<>(), perms = new java.util.ArrayList<>();
                    for (String s : r.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(s)) { want.add(s); if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) perms.add(Manifest.permission.CAMERA); }
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(s)) { want.add(s); if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) perms.add(Manifest.permission.RECORD_AUDIO); }
                    }
                    if (want.isEmpty()) { r.deny(); return; }
                    if (perms.isEmpty()) { r.grant(want.toArray(new String[0])); return; }
                    camAsk = r;
                    requestPermissions(perms.toArray(new String[0]), REQ_CAM);
                });
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                if (u.startsWith("https://honggame.store/__hsphone/frame")) return frame(r.getUrl());
                return null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (u.toString().startsWith(BASE) && u.getFragment() != null) return false;   // a link inside the page
                openUrl(u.toString());
                return true;
            }
        });
        web.setDownloadListener((url, ua, cd, mime, len) -> openUrl(url));
        /* Android 15+ draws apps under the status and navigation bars: keep the page clear of them */
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(Color.rgb(16, 18, 22));
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        root.setOnApplyWindowInsetsListener((v, ins) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = ins.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout() | android.view.WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            } else v.setPadding(ins.getSystemWindowInsetLeft(), ins.getSystemWindowInsetTop(), ins.getSystemWindowInsetRight(), ins.getSystemWindowInsetBottom());
            return ins;
        });
        setContentView(root);
        /* back: go back in the page, else leave Hóng Sub running behind the game */
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        String html = readAsset("app.html");
        web.loadDataWithBaseURL(BASE, html, "text/html", "utf-8", null);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        Updater.check(this, true, 10 * 60 * 1000L, null);
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[65536]; int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return o.toString("UTF-8");
        } catch (Exception e) { return "<p>Không mở được Hóng Sub.</p>"; }
    }

    /** the newest picture of the screen for the page, or "nothing new" (204) */
    private WebResourceResponse frame(Uri u) {
        int after = 0;
        try { after = Integer.parseInt(u.getQueryParameter("after")); } catch (Exception ignored) { }
        CaptureService.Frame f = CaptureService.frame(after);
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        if (f == null) return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", h, new ByteArrayInputStream(new byte[0]));
        h.put("X-Seq", String.valueOf(f.seq));
        h.put("Access-Control-Expose-Headers", "X-Seq");
        return new WebResourceResponse("image/jpeg", null, 200, "OK", h, new ByteArrayInputStream(f.jpeg));
    }

    void openUrl(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
    }

    /** to the page: an event (capture started, a command from the floating button, a region drawn over the game) */
    static void event(String type, String json) {
        MainActivity a = current.get();
        if (a == null || a.web == null) return;
        String js = "window.hsPhoneEvt&&window.hsPhoneEvt(" + org.json.JSONObject.quote(type) + "," + org.json.JSONObject.quote(json == null ? "{}" : json) + ")";
        a.main.post(() -> { try { a.web.evaluateJavascript(js, null); } catch (Exception ignored) { } });
    }

    static void bringToFront(android.content.Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        try { c.startActivity(i); } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------ screen recording

    void askCapture() {
        if (CaptureService.running) { CaptureService.announce(); return; }
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            wantCapture = true;
            Toast.makeText(this, "Bật \"Hiển thị trên ứng dụng khác\" cho Hóng Sub rồi quay lại.", Toast.LENGTH_LONG).show();
            try { startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))); }
            catch (Exception e) { startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)); }
            return;
        }
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_CAPTURE) return;
        if (res != RESULT_OK || data == null) { event("denied", "{}"); return; }
        Intent s = new Intent(this, CaptureService.class).putExtra(CaptureService.EXTRA_CODE, res).putExtra(CaptureService.EXTRA_DATA, data);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(s); else startService(s);
    }

    @Override
    protected void onResume() {
        super.onResume();
        CaptureService.front(true);
        if (wantCapture && (Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this))) { wantCapture = false; main.postDelayed(this::askCapture, 300); }
    }

    @Override
    protected void onPause() {
        super.onPause();
        CaptureService.front(false);   // note: the page keeps running (no web.onPause), it translates while PS Remote Play is in front
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        super.onRequestPermissionsResult(req, perms, res);
        if (req == REQ_CAM && camAsk != null) {
            /* grant what Android allowed: the camera, the microphone, or both */
            java.util.ArrayList<String> ok = new java.util.ArrayList<>();
            for (String s : camAsk.getResources()) {
                String need = PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(s) ? Manifest.permission.CAMERA : PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(s) ? Manifest.permission.RECORD_AUDIO : null;
                if (need != null && checkSelfPermission(need) == PackageManager.PERMISSION_GRANTED) ok.add(s);
            }
            if (ok.isEmpty()) camAsk.deny(); else camAsk.grant(ok.toArray(new String[0]));
            camAsk = null;
        }
    }

    private void goBack() {
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        moveTaskToBack(true);   // keep Hóng Sub running behind the game
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() { goBack(); }

    @Override
    protected void onDestroy() {
        if (current.get() == this) current = new WeakReference<>(null);
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    /** What the Hóng Sub page may ask of the phone. Called on a background thread of the WebView. */
    final class Bridge {
        @JavascriptInterface public void ready(String json) { }
        @JavascriptInterface public void startCapture() { main.post(MainActivity.this::askCapture); }
        @JavascriptInterface public void stopCapture() { main.post(() -> startService(new Intent(MainActivity.this, CaptureService.class).setAction(CaptureService.ACTION_STOP))); }
        @JavascriptInterface public String voices() { return Voice.list(); }
        @JavascriptInterface public void speak(String text, String voice, double rate, double pitch, boolean queue) { Voice.speak(text, voice, (float) rate, (float) pitch, queue); }
        @JavascriptInterface public void stopSpeak() { Voice.stop(); }
        @JavascriptInterface public void sub(String json) { CaptureService.post("sub", json); }
        @JavascriptInterface public void place(String json) { CaptureService.post("place", json); }
        @JavascriptInterface public void zones(String json) { CaptureService.post("zones", json); }
        @JavascriptInterface public void full(String json) { CaptureService.post("full", json); }
        @JavascriptInterface public void state(String json) { CaptureService.post("state", json); }
        @JavascriptInterface public void openUrl(String url) { main.post(() -> MainActivity.this.openUrl(url)); }
        @JavascriptInterface public String version() { return Updater.current(MainActivity.this); }
        /* PS5 / PS4 inside Hóng Sub: where the Remote Play core listens, and the Sony sign-in */
        @JavascriptInterface public String rp() { return Hsrp.info(); }
        @JavascriptInterface public void nat(String cmd, String id) { main.post(() -> nativeCall(cmd, id)); }
    }

    private void nativeCall(String cmd, String id) {
        if ("psnLogin".equals(cmd)) PsnLogin.show(this, json -> reply(id, json));
        else if ("psnCancel".equals(cmd)) { PsnLogin.cancel(); reply(id, "{\"ok\":true}"); }
        else reply(id, "{\"ok\":false,\"err\":\"unknown\"}");
    }

    private void reply(String id, String json) {
        if (web == null) return;
        String js = "window.hsNat&&window.hsNat(" + org.json.JSONObject.quote(id) + "," + org.json.JSONObject.quote(json) + ")";
        main.post(() -> { try { if (web != null) web.evaluateJavascript(js, null); } catch (Exception ignored) { } });
    }
}
