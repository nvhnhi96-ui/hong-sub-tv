package store.honggame.hongsub;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
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
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/** TV Samsung from the phone: what the page cannot do itself.
 *  - the Samsung account sign-in page in a window of the app (Samsung's page posts the result to
 *    http://localhost:4794/signin/callback, where the phone's core catches it, hsnet.c)
 *  - plain HTTPS requests to Samsung's certificate service (multipart forms), which a web page may not send */
final class SamsungTv {
    interface Done { void done(String json); }

    private static Dialog dlg;
    private static Done pending;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private SamsungTv() { }

    private static void finish(String json) {
        Done d = pending; pending = null;
        Dialog x = dlg; dlg = null;
        if (x != null) try { x.dismiss(); } catch (Exception ignored) { }
        if (d != null) d.done(json);
    }

    static void close() { main.post(() -> finish("{\"ok\":true}")); }

    @SuppressLint("SetJavaScriptEnabled")
    static void login(Activity a, String url, Done done) {
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
        t.setText("Đăng nhập tài khoản Samsung");
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
        s.setDatabaseEnabled(true);
        s.setSupportMultipleWindows(false);   /* links that open a window stay in this one */
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/\\d+\\.\\d+ ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        w.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                /* Google does not sign in inside an app window: Samsung's own e-mail and password only */
                if (u != null && "accounts.google.com".equalsIgnoreCase(u.getHost())) {
                    Toast.makeText(a, "Đăng nhập bằng Google không dùng được ở đây. Dùng email và mật khẩu tài khoản Samsung (đặt mật khẩu trong tài khoản Samsung nếu chưa có).", Toast.LENGTH_LONG).show();
                    return true;
                }
                return false;
            }
            @Override public void onPageFinished(WebView v, String url) {
                /* Samsung's page sent the sign-in to the phone's catcher: done */
                if (url != null && (url.startsWith("http://localhost:4794") || url.startsWith("http://127.0.0.1:4794")))
                    main.postDelayed(() -> finish("{\"ok\":true}"), 400);
            }
        });
        box.addView(w, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        d.setContentView(box);
        d.setOnCancelListener(x -> finish("{\"ok\":false,\"err\":\"closed\"}"));
        d.setOnDismissListener(x -> { try { w.destroy(); } catch (Exception ignored) { } });
        dlg = d;
        d.show();
        if (d.getWindow() != null) d.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        w.loadUrl(url);
    }

    /** {url, method, fields:{name:value}, files:[{name, filename, b64, type}], headers:{...}} -> {ok, status, b64} */
    static String http(JSONObject a) {
        try {
            String url = a.getString("url");
            if (!url.startsWith("https://")) return "{\"ok\":false,\"err\":\"url\"}";
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(20000);
            c.setReadTimeout(40000);
            String method = a.optString("method", "GET");
            c.setRequestMethod(method);
            JSONObject hd = a.optJSONObject("headers");
            if (hd != null) for (Iterator<String> it = hd.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, hd.getString(k)); }
            JSONObject fields = a.optJSONObject("fields");
            JSONArray files = a.optJSONArray("files");
            if ("POST".equals(method) && (fields != null || files != null)) {
                String bnd = "----HongSub" + Long.toHexString(System.nanoTime());
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                if (fields != null) for (Iterator<String> it = fields.keys(); it.hasNext(); ) {
                    String k = it.next();
                    b.write(("--" + bnd + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" + fields.getString(k) + "\r\n").getBytes(StandardCharsets.UTF_8));
                }
                if (files != null) for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    b.write(("--" + bnd + "\r\nContent-Disposition: form-data; name=\"" + f.getString("name") + "\"; filename=\"" + f.optString("filename", "file") + "\"\r\nContent-Type: "
                            + f.optString("type", "application/octet-stream") + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    b.write(Base64.decode(f.getString("b64"), Base64.DEFAULT));
                    b.write("\r\n".getBytes(StandardCharsets.UTF_8));
                }
                b.write(("--" + bnd + "--\r\n").getBytes(StandardCharsets.UTF_8));
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + bnd);
                byte[] body = b.toByteArray();
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
            } else if (a.has("body")) {
                c.setDoOutput(true);
                byte[] body = Base64.decode(a.getString("body"), Base64.DEFAULT);
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
            }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            if (in != null) { byte[] buf = new byte[16384]; int n; while ((n = in.read(buf)) > 0) o.write(buf, 0, n); in.close(); }
            c.disconnect();
            return new JSONObject().put("ok", true).put("status", code).put("b64", Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP)).toString();
        } catch (Throwable e) {
            try { return new JSONObject().put("ok", false).put("err", String.valueOf(e.getMessage())).toString(); } catch (Exception x) { return "{\"ok\":false}"; }
        }
    }
}
