package store.honggame.hongsub;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Backup translator on Groq (OpenAI-compatible API, vision models). Blocking calls. */
final class Groq {
    static final String BASE = "https://api.groq.com/openai/v1";
    static final List<String> PREF = Arrays.asList(
            "meta-llama/llama-4-scout-17b-16e-instruct",
            "meta-llama/llama-4-maverick-17b-128e-instruct",
            "qwen/qwen3.6-27b");

    private final Prefs prefs;
    private int keyIdx = 0;
    private final Map<String, Long> cool = new HashMap<>();
    private final Set<String> noFormat = new HashSet<>();
    private String model;

    Groq(Prefs p) {
        prefs = p;
        model = p.groqModels().get(0);
    }

    String model() { return model; }

    private static String[] http(String method, String url, String key, String body) throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Authorization", "Bearer " + key);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (java.io.OutputStream os = c.getOutputStream()) {
                os.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        java.io.InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = "";
        if (in != null) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
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

    /** Vision-capable models this key can use, preferred ones first. */
    static List<String> listModels(String key) throws Exception {
        String[] r = http("GET", BASE + "/models", key, null);
        int code = Integer.parseInt(r[0]);
        if (code != 200) throw new Exception(code == 401 ? "Mã không hợp lệ" : errMsg(r[1], code));
        JSONArray data = new JSONObject(r[1]).optJSONArray("data");
        List<String> ids = new ArrayList<>();
        if (data != null) for (int i = 0; i < data.length(); i++) ids.add(data.getJSONObject(i).optString("id"));
        List<String> out = new ArrayList<>();
        for (String m : PREF) if (ids.contains(m)) out.add(m);
        Pattern vision = Pattern.compile("llama-4|vision|-vl\\b|qwen3\\.[6-9]", Pattern.CASE_INSENSITIVE);
        Pattern skip = Pattern.compile("guard|whisper|tts|prompt", Pattern.CASE_INSENSITIVE);
        for (String id : ids) {
            if (!out.contains(id) && vision.matcher(id).find() && !skip.matcher(id).find()) out.add(id);
        }
        return out.isEmpty() ? new ArrayList<>(PREF) : out;
    }

    private String pickKey() {
        List<String> ks = prefs.groqKeys();
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

    static JSONObject jsonFrom(String t) {
        if (t == null) return null;
        t = t.replaceAll("(?s)<think>.*?</think>", "");
        int a = t.indexOf('{'), b = t.lastIndexOf('}');
        if (a < 0 || b < a) return null;
        try {
            return new JSONObject(t.substring(a, b + 1));
        } catch (Exception e) {
            return null;
        }
    }

    JSONObject ask(String prompt, String jpegB64, String shape) throws Exception {
        List<String> ms = prefs.groqModels();
        if (!ms.contains(model)) model = ms.get(0);
        Exception last = null;
        int tries = ms.size() + prefs.groqKeys().size() + 1;
        for (int t = 0; t < tries; t++) {
            String key = pickKey();
            if (key == null) throw new Gemini.CoolException();
            JSONArray content = new JSONArray()
                    .put(new JSONObject().put("type", "text").put("text", prompt + "\nReply with JSON only, exactly this shape: " + shape))
                    .put(new JSONObject().put("type", "image_url").put("image_url",
                            new JSONObject().put("url", "data:image/jpeg;base64," + jpegB64)));
            JSONObject body = new JSONObject()
                    .put("model", model)
                    .put("temperature", 0.2)
                    .put("max_completion_tokens", 1024)
                    .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", content)));
            if (!noFormat.contains(model)) body.put("response_format", new JSONObject().put("type", "json_object"));
            String[] r;
            try {
                r = http("POST", BASE + "/chat/completions", key, body.toString());
            } catch (Exception e) {
                last = new Exception("Mất kết nối mạng");
                continue;
            }
            int code = Integer.parseInt(r[0]);
            if (code == 200) {
                JSONArray ch = new JSONObject(r[1]).optJSONArray("choices");
                if (ch == null || ch.length() == 0) return null;
                JSONObject msg = ch.getJSONObject(0).optJSONObject("message");
                return jsonFrom(msg != null ? msg.optString("content", "") : "");
            }
            String msg = errMsg(r[1], code);
            last = new Exception(msg);
            String low = msg.toLowerCase();
            if (code == 400 && (low.contains("response_format") || low.contains("json")) && !noFormat.contains(model)) {
                noFormat.add(model);
                continue;
            }
            if (code == 429) {
                Matcher m = Pattern.compile("try again in ([\\d.]+)(ms|s|m)", Pattern.CASE_INSENSITIVE).matcher(msg);
                long wait = 20000;
                if (m.find()) {
                    double v = Double.parseDouble(m.group(1));
                    String u = m.group(2).toLowerCase();
                    wait = (long) (u.equals("ms") ? v : u.equals("m") ? v * 60000 : v * 1000);
                }
                cool.put(key, System.currentTimeMillis() + wait);
                continue;
            }
            if (code == 404 || (code == 400 && (low.contains("model") || low.contains("decommission")))) {
                int i = ms.indexOf(model);
                model = ms.get((i + 1) % ms.size());
                continue;
            }
            if (code == 401 || code == 403) { cool.put(key, System.currentTimeMillis() + 3600_000L); continue; }
            if (code >= 500) continue;
            break;
        }
        throw last != null ? last : new Exception("Groq không dịch được");
    }
}
