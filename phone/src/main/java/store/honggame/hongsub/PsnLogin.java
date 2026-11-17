package store.honggame.hongsub;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.SecureRandom;

/**
 * Sign in to PlayStation Network on Sony's own page, only to read the account id that pairing with the PS5 needs
 * (the same sign-in as PS Remote Play and chiaki-ng). Hóng Sub never sees the password: Sony's page takes it,
 * then sends the browser to .../remoteplay/redirect?code=..., and that code is exchanged for the account id.
 */
final class PsnLogin {
    interface Done { void done(String json); }

    private static final String CLIENT_ID = "ba495a24-818c-472b-b12d-ff231c1b5745";
    private static final String CLIENT_SECRET = "mvaiZkRsAsI1IBkY";
    private static final String SCOPE = "psn:clientapp referenceDataService:countryConfig.read pushNotification:webSocket.desktop.connect sessionManager:remotePlaySession.system.update";
    private static final String REDIRECT = "https://remoteplay.dl.playstation.net/remoteplay/redirect";
    private static final String TOKEN_URL = "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token";

    private static Dialog dlg;
    private static Done pending;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private static String loginUrl() {
        byte[] r = new byte[16];
        new SecureRandom().nextBytes(r);
        StringBuilder duid = new StringBuilder("0000000700410080");
        for (byte b : r) duid.append(String.format("%02x", b & 255));
        try {
            return "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize?service_entity=urn:service-entity:psn&response_type=code&client_id=" + CLIENT_ID
                    + "&redirect_uri=" + REDIRECT + "&scope=" + URLEncoder.encode(SCOPE, "UTF-8").replace("+", "%20")
                    + "&request_locale=en_US&ui=pr&service_logo=ps&layout_type=popup&smcid=remoteplay&prompt=always&PlatformPrivacyWs1=minimal&duid=" + duid + "&";
        } catch (Exception e) { return ""; }
    }

    private static void finish(String json) {
        Done d = pending; pending = null;
        Dialog x = dlg; dlg = null;
        if (x != null) try { x.dismiss(); } catch (Exception ignored) { }
        if (d != null) d.done(json);
    }

    static void cancel() { main.post(() -> finish("{\"ok\":false,\"err\":\"closed\"}")); }

    @SuppressLint("SetJavaScriptEnabled")
    static void show(Activity a, Done done) {
        if (pending != null) finish("{\"ok\":false,\"err\":\"again\"}");
        pending = done;
        Dialog d = new Dialog(a, android.R.style.Theme_DeviceDefault_NoActionBar);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.rgb(16, 18, 22));
        LinearLayout bar = new LinearLayout(a);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = (int) (12 * a.getResources().getDisplayMetrics().density);
        bar.setPadding(pad, pad / 2, pad / 2, pad / 2);
        TextView t = new TextView(a);
        t.setText("Đăng nhập PlayStation Network");
        t.setTextColor(Color.WHITE);
        t.setTextSize(16);
        bar.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button close = new Button(a);
        close.setText("Đóng");
        close.setOnClickListener(v -> finish("{\"ok\":false,\"err\":\"closed\"}"));
        bar.addView(close);
        box.addView(bar);
        WebView w = new WebView(a);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        /* look like Chrome on this phone: Sony's robot check is stricter with app windows */
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/\\d+\\.\\d+ ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        w.setWebViewClient(new WebViewClient() {
            private boolean check(String url) {
                if (url == null || !url.startsWith(REDIRECT)) return false;
                String code = Uri.parse(url).getQueryParameter("code");
                if (code == null || code.isEmpty()) { finish("{\"ok\":false,\"err\":\"" + (url.contains("error") ? "denied" : "code") + "\"}"); return true; }
                new Thread(() -> {
                    String res = exchange(code);
                    main.post(() -> finish(res));
                }).start();
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return check(r.getUrl().toString()); }
            @Override public void onPageStarted(WebView v, String url, Bitmap fav) { if (check(url)) v.stopLoading(); }
            @Override public void onPageFinished(WebView v, String url) {
                /* Sony's "Can't connect to the server": its robot check refused, say so instead of leaving it there */
                v.evaluateJavascript("document.body?document.body.innerText.slice(0,3000):''", txt -> {
                    if (txt != null && txt.matches("(?is).*(can.t connect to the server|không thể kết nối với máy chủ).*")) finish("{\"ok\":false,\"err\":\"blocked\"}");
                });
            }
        });
        box.addView(w, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        d.setContentView(box);
        d.setOnCancelListener(x -> finish("{\"ok\":false,\"err\":\"closed\"}"));
        d.setOnDismissListener(x -> { try { w.destroy(); } catch (Exception ignored) { } });
        dlg = d;
        d.show();
        if (d.getWindow() != null) d.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        w.loadUrl(loginUrl());
    }

    private static String http(String url, String method, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Authorization", "Basic " + Base64.encodeToString((CLIENT_ID + ":" + CLIENT_SECRET).getBytes("UTF-8"), Base64.NO_WRAP));
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes("UTF-8")); }
        }
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        if (in != null) { byte[] b = new byte[8192]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); in.close(); }
        String txt = o.toString("UTF-8");
        if (code >= 400) {
            String err = "HTTP " + code;
            try { JSONObject j = new JSONObject(txt); err = j.optString("error_description", j.optString("error", err)); } catch (Exception ignored) { }
            throw new Exception(err);
        }
        return txt;
    }

    /** the code from Sony's page -> the account id (8 bytes, little endian, base64) that pairing needs */
    private static String exchange(String code) {
        try {
            String body = "grant_type=authorization_code&code=" + URLEncoder.encode(code, "UTF-8") + "&scope=" + URLEncoder.encode(SCOPE, "UTF-8")
                    + "&redirect_uri=" + URLEncoder.encode(REDIRECT, "UTF-8") + "&";
            JSONObject tok = new JSONObject(http(TOKEN_URL, "POST", body));
            String at = tok.optString("access_token", "");
            if (at.isEmpty()) return "{\"ok\":false,\"err\":\"token\"}";
            JSONObject me = new JSONObject(http(TOKEN_URL + "/" + at, "GET", null));
            String uid = me.optString("user_id", "");
            if (uid.isEmpty()) return "{\"ok\":false,\"err\":\"account\"}";
            long v = new BigInteger(uid).longValue();
            byte[] le = new byte[8];
            for (int i = 0; i < 8; i++) le[i] = (byte) (v >>> (8 * i));
            JSONObject r = new JSONObject();
            r.put("ok", true);
            r.put("account", Base64.encodeToString(le, Base64.NO_WRAP));
            r.put("onlineId", me.optString("online_id", ""));
            return r.toString();
        } catch (Exception e) {
            JSONObject r = new JSONObject();
            try { r.put("ok", false); r.put("err", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
            return r.toString();
        }
    }

    private PsnLogin() { }
}
