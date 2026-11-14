package store.honggame.hongsub;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** "AI dịch thông minh": larger models through OpenRouter (one key, many models). Blocking calls. */
final class OpenRouter {
    static final String BASE = "https://openrouter.ai/api/v1";
    /* free models when the account has no credit; good cheap models first when it has */
    static final Pattern[] FREE = {
            Pattern.compile("^google/gemma-4-31b-it:free$"), Pattern.compile("^deepseek/.*:free$"),
            Pattern.compile("^qwen/qwen3.*:free$"), Pattern.compile("^google/gemma-4.*:free$"),
            Pattern.compile("^nvidia/nemotron-3-ultra.*:free$"), Pattern.compile("^baidu/ernie-.*flash.*:free$")};
    static final Pattern[] PAID = {
            Pattern.compile("^deepseek/deepseek-v\\d+(\\.\\d+)?-flash(-\\d+)?$"), Pattern.compile("^google/gemini-\\d+(\\.\\d+)?-flash$"),
            Pattern.compile("^qwen/qwen3[\\d.]*-(max|235b[\\w-]*)$"), Pattern.compile("^moonshotai/kimi-k\\d[\\w.-]*$")};

    private final Prefs prefs;
    private int keyIdx = 0;
    private static final Map<String, Long> cool = new java.util.concurrent.ConcurrentHashMap<>();
    private static final Map<String, Long> bad = new java.util.concurrent.ConcurrentHashMap<>();
    private static final Set<String> noFormat = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private static final Set<String> noReason = java.util.concurrent.ConcurrentHashMap.newKeySet();
    volatile String lastModel = "";

    OpenRouter(Prefs p) { prefs = p; }

    static String[] http(String method, String url, String key, String body, int timeout) throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10000);
        c.setReadTimeout(timeout);
        if (key != null) c.setRequestProperty("Authorization", "Bearer " + key);
        c.setRequestProperty("HTTP-Referer", "https://honggame.store/hong-sub/");
        c.setRequestProperty("X-Title", "Hong Sub");
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (java.io.OutputStream os = c.getOutputStream()) { os.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        }
        int code = c.getResponseCode();
        java.io.InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = "";
        if (in != null) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            text = bo.toString("UTF-8");
        }
        c.disconnect();
        return new String[]{String.valueOf(code), text};
    }

    private static String errMsg(String body, int code) {
        try { JSONObject e = new JSONObject(body).getJSONObject("error"); return e.optString("message", e.optString("code", "HTTP " + code)); }
        catch (Exception e) { return "HTTP " + code; }
    }

    boolean ready() {
        List<String> ks = prefs.orKeys(); long now = System.currentTimeMillis();
        for (String k : ks) { Long u = cool.get(k); if (u == null || u < now) return true; }
        return false;
    }

    /** reads the model list and whether the account has credit; returns the ranked models */
    List<String> refresh() throws Exception {
        List<String> ks = prefs.orKeys();
        if (ks.isEmpty()) return new ArrayList<>();
        String[] r = http("GET", BASE + "/models", null, null, 20000);
        if (!"200".equals(r[0])) throw new Exception("OpenRouter lỗi " + r[0]);
        JSONArray data = new JSONObject(r[1]).optJSONArray("data");
        List<String> ids = new ArrayList<>();
        if (data != null) for (int i = 0; i < data.length(); i++) ids.add(data.getJSONObject(i).optString("id"));
        boolean paid = false;
        String[] c = http("GET", BASE + "/credits", ks.get(0), null, 15000);
        if ("401".equals(c[0]) || "403".equals(c[0])) throw new Exception("Mã OpenRouter không hợp lệ");
        if ("200".equals(c[0])) {
            JSONObject d = new JSONObject(c[1]).optJSONObject("data");
            if (d != null) paid = d.optDouble("total_credits", 0) - d.optDouble("total_usage", 0) > 0.02;
        }
        List<String> out = new ArrayList<>();
        if (paid) take(ids, PAID, out);
        take(ids, FREE, out);
        prefs.orModels(out); prefs.orPaid(paid); prefs.orListed(System.currentTimeMillis());
        return out;
    }

    private static void take(List<String> ids, Pattern[] pats, List<String> out) {
        for (Pattern p : pats) {
            List<String> hit = new ArrayList<>();
            for (String id : ids) if (p.matcher(id).matches() && !out.contains(id)) hit.add(id);
            hit.sort(java.util.Collections.reverseOrder());
            out.addAll(hit);
        }
    }

    private String pickKey() {
        List<String> ks = prefs.orKeys(); if (ks.isEmpty()) return null;
        long now = System.currentTimeMillis();
        for (int i = 0; i < ks.size(); i++) {
            String k = ks.get((keyIdx + i) % ks.size()); Long u = cool.get(k);
            if (u == null || u < now) { keyIdx = (keyIdx + i + 1) % ks.size(); return k; }
        }
        return null;
    }

    private static long tomorrowUtc() {
        java.util.Calendar c = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"));
        c.add(java.util.Calendar.DAY_OF_MONTH, 1);
        c.set(java.util.Calendar.HOUR_OF_DAY, 0); c.set(java.util.Calendar.MINUTE, 5); c.set(java.util.Calendar.SECOND, 0);
        return c.getTimeInMillis();
    }

    JSONObject ask(String prompt, String shape) throws Exception {
        if (prefs.orModels().isEmpty() || System.currentTimeMillis() - prefs.orListed() > 12 * 3600_000L) {
            try { refresh(); } catch (Exception ignored) { }
        }
        Exception last = null;
        for (int t = 0; t < 6; t++) {
            List<String> order = new ArrayList<>(); long now = System.currentTimeMillis();
            for (String m : prefs.orModels()) { Long b = bad.get(m); if (b == null || b < now) order.add(m); }
            if (order.isEmpty()) break;
            String m = order.get(0), key = pickKey();
            if (key == null) throw new Gemini.CoolException();
            JSONObject body = new JSONObject().put("model", m).put("temperature", 0.2).put("max_tokens", 700)
                    .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", prompt + "\nReply with JSON only, exactly this shape: " + shape)));
            if (!noFormat.contains(m)) body.put("response_format", new JSONObject().put("type", "json_object"));
            if (!noReason.contains(m)) body.put("reasoning", new JSONObject().put("enabled", false));
            if (!m.endsWith(":free")) body.put("provider", new JSONObject().put("sort", "latency"));
            String[] r;
            try { r = http("POST", BASE + "/chat/completions", key, body.toString(), 30000); }
            catch (Exception e) { last = new Exception("Mất kết nối mạng"); continue; }
            int code = Integer.parseInt(r[0]);
            if (code == 200) {
                JSONObject j = new JSONObject(r[1]);
                if (j.has("error")) { last = new Exception(errMsg(r[1], code)); bad.put(m, now + 30000); continue; }
                JSONArray ch = j.optJSONArray("choices");
                JSONObject msg = ch != null && ch.length() > 0 ? ch.getJSONObject(0).optJSONObject("message") : null;
                JSONObject out = Groq.jsonFrom(msg != null ? msg.optString("content", "") : "");
                if (out != null) { lastModel = m; return out; }
                last = new Exception("AI thông minh trả lời sai dạng"); continue;
            }
            String msg = errMsg(r[1], code), low = msg.toLowerCase();
            last = new Exception(msg);
            if (code == 400 && low.contains("reasoning") && !noReason.contains(m)) { noReason.add(m); continue; }
            if (code == 400 && (low.contains("response_format") || low.contains("json")) && !noFormat.contains(m)) { noFormat.add(m); continue; }
            if (code == 402) { prefs.orPaid(false); try { refresh(); } catch (Exception ignored) { } continue; }
            if (code == 429) {
                if (low.matches("(?s).*(per.?day|daily|free-models-per-day).*")) { if (m.endsWith(":free")) cool.put(key, prefs.orPaid() ? now + 60000 : tomorrowUtc()); }
                else bad.put(m, now + 30000);
                continue;
            }
            if (code == 404 || code == 400) { bad.put(m, now + 12 * 3600_000L); continue; }
            if (code == 401 || code == 403) { cool.put(key, now + 3600_000L); continue; }
            if (code >= 500) { bad.put(m, now + 60000); continue; }
            break;
        }
        throw last != null ? last : new Exception("AI thông minh không dịch được");
    }
}
