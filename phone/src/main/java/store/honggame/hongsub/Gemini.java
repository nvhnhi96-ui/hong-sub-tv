package store.honggame.hongsub;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Minimal Gemini REST client with key rotation and model fallback. All calls are blocking. */
final class Gemini {
    static final String BASE = "https://generativelanguage.googleapis.com/v1beta/models";

    static final class CoolException extends Exception {
        CoolException() { super("Mã tạm hết lượt"); }
    }

    private final Prefs prefs;
    private int keyIdx = 0;
    private final Map<String, Long> cool = new HashMap<>();
    private final Set<String> noThink = new HashSet<>();
    // speed: measured answer time per model, slow models are skipped for a while
    private static final Map<String, Long> LAT = new HashMap<>();
    private static final Map<String, Long> SLOW = new HashMap<>();
    private static final Set<String> NO_MIN = new HashSet<>();
    private String model;

    Gemini(Prefs p) {
        prefs = p;
        model = p.models().get(0);
    }

    String model() { return model; }

    static String[] http(String method, String url, String body) throws Exception {
        return http(method, url, body, 30000);
    }

    static String[] http(String method, String url, String body, int readTimeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(readTimeout);
        c.setUseCaches(false);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = "";
        if (in != null) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            text = bo.toString("UTF-8");
        }
        c.disconnect();
        return new String[]{String.valueOf(code), text};
    }

    private static String errMsg(String body, int code) {
        try {
            return new JSONObject(body).getJSONObject("error").optString("message", "HTTP " + code);
        } catch (Exception e) {
            return "HTTP " + code;
        }
    }

    /** Lists models this key can use for generateContent, ranked fastest first. */
    static List<String> listModels(String key) throws Exception {
        String[] r = http("GET", BASE + "?pageSize=200&key=" + URLEncoder.encode(key, "UTF-8"), null);
        int code = Integer.parseInt(r[0]);
        if (code != 200) throw new Exception(code == 400 || code == 403 ? "Mã không hợp lệ" : errMsg(r[1], code));
        JSONArray arr = new JSONObject(r[1]).optJSONArray("models");
        List<String> names = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.getJSONObject(i);
                JSONArray methods = m.optJSONArray("supportedGenerationMethods");
                if (methods != null && methods.toString().contains("generateContent")) {
                    names.add(m.optString("name").replace("models/", ""));
                }
            }
        }
        return rank(names);
    }

    static List<String> rank(List<String> names) {
        Pattern p = Pattern.compile("^gemini-(\\d+(?:\\.\\d+)?)-flash(-lite)?$");
        List<Object[]> items = new ArrayList<>();
        for (String n : names) {
            Matcher m = p.matcher(n);
            if (m.matches()) items.add(new Object[]{n, Double.parseDouble(m.group(1)), m.group(2) != null});
            else if (n.equals("gemini-flash-lite-latest")) items.add(new Object[]{n, 99.0, true});
            else if (n.equals("gemini-flash-latest")) items.add(new Object[]{n, 99.0, false});
        }
        Collections.sort(items, (a, b) -> {
            boolean la = (Boolean) a[2], lb = (Boolean) b[2];
            if (la != lb) return la ? -1 : 1;
            return Double.compare((Double) b[1], (Double) a[1]);
        });
        List<String> out = new ArrayList<>();
        for (Object[] o : items) out.add((String) o[0]);
        return out;
    }

    private String pickKey() {
        List<String> ks = prefs.keys();
        if (ks.isEmpty()) return null;
        long now = System.currentTimeMillis();
        for (int i = 0; i < ks.size(); i++) {
            String k = ks.get((keyIdx + i) % ks.size());
            Long until = cool.get(k);
            if (until == null || until < now) {
                keyIdx = (keyIdx + i + 1) % ks.size();
                return k;
            }
        }
        return null;
    }

    private JSONObject thinking(String m) {
        if (noThink.contains(m)) return null;
        try {
            Matcher mm = Pattern.compile("gemini-(\\d+)").matcher(m);
            int v = mm.find() ? Integer.parseInt(mm.group(1)) : (m.contains("latest") ? 3 : 2);
            // "low" thinking made every line take ~10s; "minimal" answers in 1-2s
            if (v < 3) return new JSONObject().put("thinkingBudget", 0);
            return new JSONObject().put("thinkingLevel", NO_MIN.contains(m) ? "low" : "minimal");
        } catch (Exception e) {
            return null;
        }
    }

    private void nextModel() {
        SLOW.put(model, System.currentTimeMillis() + 12 * 3600_000L);
        model = fastest();
    }

    private String fastest() {
        List<String> ms = prefs.models();
        long now = System.currentTimeMillis();
        String best = ms.get(0);
        long bestScore = Long.MAX_VALUE;
        for (int i = 0; i < ms.size(); i++) {
            String m = ms.get(i);
            Long l = LAT.get(m), until = SLOW.get(m);
            long sc = (l == null ? 2500 : l) + i * 40L;
            if (until != null && until > now) sc += 1_000_000;
            if (!m.contains("lite")) sc += 1500;
            if (m.contains("pro")) sc += 8000;
            if (m.endsWith("-latest")) sc += 300;
            if (sc < bestScore) { bestScore = sc; best = m; }
        }
        return best;
    }

    private static void noteLat(String m, long ms) {
        Long old = LAT.get(m);
        LAT.put(m, old == null ? ms : Math.round(old * 0.6 + ms * 0.4));
    }

    /** Sends one image + prompt, returns the parsed JSON object the model produced (or null). */
    JSONObject ask(String prompt, String jpegB64, JSONObject schema) throws Exception {
        List<String> ms = prefs.models();
        model = fastest();
        Exception last = null;
        int tries = ms.size() + prefs.keys().size() + 1;
        for (int t = 0; t < tries; t++) {
            String key = pickKey();
            if (key == null) throw new CoolException();
            JSONObject gc = new JSONObject();
            gc.put("responseMimeType", "application/json");
            gc.put("responseSchema", schema);
            gc.put("maxOutputTokens", 1024);
            JSONObject th = thinking(model);
            if (th != null) gc.put("thinkingConfig", th);
            JSONObject img = new JSONObject().put("inlineData",
                    new JSONObject().put("mimeType", "image/jpeg").put("data", jpegB64));
            JSONArray parts = new JSONArray().put(new JSONObject().put("text", prompt));
            if (jpegB64 != null) parts.put(img);
            JSONObject body = new JSONObject()
                    .put("contents", new JSONArray().put(new JSONObject().put("role", "user").put("parts", parts)))
                    .put("generationConfig", gc);
            String[] r;
            long t0 = System.currentTimeMillis();
            try {
                r = http("POST", BASE + "/" + model + ":generateContent?key=" + URLEncoder.encode(key, "UTF-8"), body.toString(), 6000);
            } catch (java.net.SocketTimeoutException e) {
                // this model is answering slowly right now: use another one for a few minutes
                noteLat(model, System.currentTimeMillis() - t0 + 2000);
                SLOW.put(model, System.currentTimeMillis() + 5 * 60_000L);
                model = fastest();
                last = new Exception("Gemini phản hồi chậm, thử lại...");
                continue;
            } catch (Exception e) {
                last = new Exception("Mất kết nối mạng");
                continue;
            }
            int code = Integer.parseInt(r[0]);
            if (code == 200) {
                noteLat(model, System.currentTimeMillis() - t0);
                JSONObject j = new JSONObject(r[1]);
                JSONArray cands = j.optJSONArray("candidates");
                if (cands == null || cands.length() == 0) return null;
                JSONArray ps = cands.getJSONObject(0).optJSONObject("content") != null
                        ? cands.getJSONObject(0).getJSONObject("content").optJSONArray("parts") : null;
                StringBuilder sb = new StringBuilder();
                if (ps != null) for (int i = 0; i < ps.length(); i++) sb.append(ps.getJSONObject(i).optString("text", ""));
                try {
                    return new JSONObject(sb.toString());
                } catch (Exception e) {
                    return null;
                }
            }
            String msg = errMsg(r[1], code);
            last = new Exception(msg);
            if (code == 400 && msg.toLowerCase().contains("thinking")) {
                if (msg.toLowerCase().contains("minimal") && !NO_MIN.contains(model)) NO_MIN.add(model);
                else if (!noThink.contains(model)) noThink.add(model);
                else break;
                continue;
            }
            if (code == 429) {
                if (msg.matches("(?s).*limit:\\s*0\\b.*")) { nextModel(); continue; }
                Matcher m = Pattern.compile("retry in ([\\d.]+)s", Pattern.CASE_INSENSITIVE).matcher(msg);
                long wait = m.find() ? (long) (Double.parseDouble(m.group(1)) * 1000) : 30000;
                cool.put(key, System.currentTimeMillis() + wait);
                continue;
            }
            if (code == 404 || (code == 400 && msg.toLowerCase().contains("model"))) { nextModel(); continue; }
            if (code == 400 || code == 403) { cool.put(key, System.currentTimeMillis() + 3600_000L); continue; }
            if (code >= 500) { SLOW.put(model, System.currentTimeMillis() + 60_000L); model = fastest(); continue; }
            break;
        }
        throw last != null ? last : new Exception("Không dịch được");
    }
}
