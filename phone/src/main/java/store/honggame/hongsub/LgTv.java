package store.honggame.hongsub;

import android.content.Context;
import android.content.SharedPreferences;

import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/** Puts the Hóng Sub app on a TV LG (webOS) from the phone, the way the computer does (pc/lg.js) and LG's own
 *  ares-install: the TV's Developer Mode app hands out an SSH key (Key Server, port 9991) locked with the passphrase
 *  shown on the TV; with it the phone copies the .ipk over SSH (port 9922, user "prisoner") and asks the TV to install
 *  it. The key is kept, so later the phone can open the app on the TV and update it without the passphrase. */
final class LgTv {
    static final String APP_ID = "store.honggame.hongsubtv";
    static final String IPK_URL = "https://github.com/nvhnhi96-ui/hong-sub-tv/releases/latest/download/hong-sub-lg.ipk";
    static final String TEMP = "/media/developer/temp";
    static final String LUNA = "/usr/bin/luna-send-pub";
    private static final Pattern IP = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    interface Progress { void say(String text); }

    private LgTv() { }

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("lgtv", Context.MODE_PRIVATE); }

    static String state(Context c) {
        SharedPreferences p = prefs(c);
        try {
            return new JSONObject().put("ok", true).put("ip", p.getString("ip", "")).put("installed", !p.getString("key", "").isEmpty())
                    .put("at", p.getLong("at", 0)).toString();
        } catch (Exception e) { return "{\"ok\":false}"; }
    }

    private static String err(String m) {
        try { return new JSONObject().put("ok", false).put("err", m).toString(); } catch (Exception e) { return "{\"ok\":false}"; }
    }

    /** old TVs speak only the older SSH ways (ssh-rsa with SHA-1): allow them as LG's own tool does */
    private static void algos() {
        String kex = JSch.getConfig("kex");
        if (!kex.contains("diffie-hellman-group14-sha1")) JSch.setConfig("kex", kex + ",diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1,diffie-hellman-group1-sha1");
        String hk = JSch.getConfig("server_host_key");
        if (!hk.contains("ssh-rsa")) JSch.setConfig("server_host_key", hk + ",ssh-rsa");
        String pk = JSch.getConfig("PubkeyAcceptedAlgorithms");
        if (pk != null && !pk.contains("ssh-rsa")) JSch.setConfig("PubkeyAcceptedAlgorithms", pk + ",ssh-rsa");
    }

    private static Session connect(String ip, String key, String pass) throws Exception {
        algos();
        JSch j = new JSch();
        j.addIdentity("webos", key.getBytes(StandardCharsets.UTF_8), null, pass.getBytes(StandardCharsets.UTF_8));
        Session s = j.getSession("prisoner", ip, 9922);
        s.setConfig("StrictHostKeyChecking", "no");
        s.setConfig("PreferredAuthentications", "publickey");
        s.connect(20000);
        return s;
    }

    interface Line { Object check(String line); }   // null: go on, Boolean.TRUE: done, a String: failed with that

    private static String run(Session s, String cmd, byte[] input, Line onLine, int ms) throws Exception {
        ChannelExec ch = (ChannelExec) s.openChannel("exec");
        ch.setCommand(cmd);
        ByteArrayOutputStream errs = new ByteArrayOutputStream();
        ch.setErrStream(errs);
        InputStream in = ch.getInputStream();
        OutputStream os = ch.getOutputStream();
        ch.connect(15000);
        StringBuilder out = new StringBuilder(), line = new StringBuilder();
        try {
            if (input != null) { os.write(input); os.flush(); os.close(); }
            else if (onLine == null) os.close();   /* luna-send -i keeps reading: leave it open */
            long end = System.currentTimeMillis() + ms;
            byte[] buf = new byte[4096];
            while (true) {
                if (System.currentTimeMillis() > end) throw new Exception("timeout");
                int n = in.available() > 0 ? in.read(buf) : 0;
                if (n > 0) {
                    String t = new String(buf, 0, n, StandardCharsets.UTF_8);
                    out.append(t);
                    for (char c : t.toCharArray()) {
                        if (c != '\n') { line.append(c); continue; }
                        String l = line.toString().trim(); line.setLength(0);
                        if (l.isEmpty() || onLine == null) continue;
                        Object r = onLine.check(l);
                        if (r instanceof String) throw new Exception((String) r);
                        if (r != null) return out.toString();
                    }
                    continue;
                }
                if (ch.isClosed()) { if (in.available() > 0) continue; break; }
                Thread.sleep(40);
            }
        } finally { ch.disconnect(); }
        return out.toString();
    }

    private static String getKey(String ip) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL("http://" + ip + ":9991/webos_rsa").openConnection();
        h.setConnectTimeout(6000); h.setReadTimeout(6000);
        try {
            if (h.getResponseCode() != 200) throw new Exception("key");
            return new String(readAll(h.getInputStream()), StandardCharsets.UTF_8);
        } finally { h.disconnect(); }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[16384]; int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        in.close(); return b.toByteArray();
    }

    private static byte[] download() throws Exception {
        URL u = new URL(IPK_URL);
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection h = (HttpURLConnection) u.openConnection();
            h.setConnectTimeout(15000); h.setReadTimeout(60000); h.setInstanceFollowRedirects(false);
            h.setRequestProperty("User-Agent", "HongSub");
            int code = h.getResponseCode();
            if (code >= 300 && code < 400 && h.getHeaderField("Location") != null) { u = new URL(u, h.getHeaderField("Location")); h.disconnect(); continue; }
            if (code != 200) { h.disconnect(); throw new Exception("HTTP " + code); }
            try { return readAll(h.getInputStream()); } finally { h.disconnect(); }
        }
        throw new Exception("redirect");
    }

    private static String launchCmd(String code, String pc) throws Exception {
        JSONObject params = new JSONObject();
        if (code != null && !code.isEmpty()) { params.put("code", code); if (pc != null && !pc.isEmpty()) params.put("pc", pc); }
        return LUNA + " -n 1 'luna://com.webos.applicationManager/launch' '" + new JSONObject().put("id", APP_ID).put("params", params).toString().replace("'", "") + "'";
    }

    /** saved: update the app with the key kept from the first install (no passphrase, no Key Server needed) */
    static String install(Context c, String ip, String pass, String code, String pc, boolean saved, Progress say) {
        SharedPreferences p = prefs(c);
        if (saved) { ip = p.getString("ip", ""); pass = p.getString("pass", ""); if (p.getString("key", "").isEmpty()) return err("no-tv"); }
        ip = ip == null ? "" : ip.trim(); pass = pass == null ? "" : pass.trim().toUpperCase();
        if (!IP.matcher(ip).matches()) return err("Nhập địa chỉ IP của TV LG (ví dụ 192.168.1.20), hoặc bấm Tìm TV LG.");
        if (!saved && pass.length() < 4) return err("Gõ Passphrase (6 chữ đang hiện trong app Developer Mode trên TV).");
        Session s = null;
        try {
            say.say("Đang lấy khóa từ TV...");
            String key;
            if (saved) key = p.getString("key", "");
            else try { key = getKey(ip); } catch (Exception e) { return err("Không lấy được khóa từ TV. Trên TV mở app Developer Mode, kiểm tra Dev Mode Status đang bật và bật Key Server, rồi thử lại."); }
            say.say("Đang kết nối với TV...");
            try { s = connect(ip, key, pass); } catch (Exception e) {
                String m = String.valueOf(e.getMessage());
                if (m.matches("(?is).*(auth|passphrase|decrypt|invalid privatekey|USERAUTH).*")) return err("Sai mã Passphrase. Gõ đúng 6 chữ đang hiện trong app Developer Mode trên TV.");
                return err("Không kết nối được TV (" + (m.length() > 80 ? m.substring(0, 80) : m) + "). Kiểm tra TV và điện thoại cùng Wi-Fi, Dev Mode Status đang bật.");
            }
            say.say("Đang tải app Hóng Sub cho TV LG...");
            byte[] ipk;
            try { ipk = download(); } catch (Exception e) { return err("Không tải được app (" + e.getMessage() + "). Kiểm tra mạng của điện thoại."); }
            say.say("Đang chép app lên TV...");
            run(s, "/bin/mkdir -p " + TEMP, null, null, 15000);
            run(s, "/bin/cat > \"" + TEMP + "/hong-sub-lg.ipk\"", ipk, null, 90000);
            say.say("TV đang cài app...");
            final String[] state = {""};
            String req = new JSONObject().put("id", APP_ID).put("ipkUrl", TEMP + "/hong-sub-lg.ipk").put("subscribe", true).toString();
            try {
                run(s, LUNA + " -i 'luna://com.webos.appInstallService/dev/install' '" + req + "'", null, l -> {
                    JSONObject j; try { j = new JSONObject(l); } catch (Exception e) { return null; }
                    JSONObject d = j.optJSONObject("details");
                    String st = d != null ? d.optString("state", "") : "";
                    if (!st.isEmpty()) state[0] = st;
                    if (st.toUpperCase().contains("FAILED") || (j.has("returnValue") && !j.optBoolean("returnValue", true))) {
                        String why = d != null ? d.optString("reason", "") : ""; if (why.isEmpty()) why = j.optString("errorText", st.isEmpty() ? "install" : st);
                        return why;
                    }
                    if (st.toLowerCase().contains("installed") || st.toUpperCase().startsWith("SUCCESS")) return Boolean.TRUE;
                    return null;
                }, 120000);
            } catch (Exception e) { return err("Cài trên TV lỗi: " + e.getMessage()); }
            try { run(s, "/bin/rm -f \"" + TEMP + "/hong-sub-lg.ipk\"", null, null, 10000); } catch (Exception ignored) { }
            say.say("Đang mở Hóng Sub trên TV...");
            try { run(s, launchCmd(code, pc), null, null, 15000); } catch (Exception ignored) { }
            p.edit().putString("ip", ip).putString("key", key).putString("pass", pass).putLong("at", System.currentTimeMillis()).apply();
            return "{\"ok\":true}";
        } catch (Exception e) {
            String m = String.valueOf(e.getMessage());
            return err(m.length() > 200 ? m.substring(0, 200) : m);
        } finally { if (s != null) try { s.disconnect(); } catch (Exception ignored) { } }
    }

    static String launch(Context c, String code, String pc) {
        SharedPreferences p = prefs(c);
        String ip = p.getString("ip", ""), key = p.getString("key", "");
        if (ip.isEmpty() || key.isEmpty()) return err("no-tv");
        Session s = null;
        try { s = connect(ip, key, p.getString("pass", "")); run(s, launchCmd(code, pc), null, null, 15000); return "{\"ok\":true}"; }
        catch (Exception e) { String m = String.valueOf(e.getMessage()); return err(m.length() > 160 ? m.substring(0, 160) : m); }
        finally { if (s != null) try { s.disconnect(); } catch (Exception ignored) { } }
    }

    static void forget(Context c) { prefs(c).edit().clear().apply(); }

    /** one call from the page: {"do":"install"|"update"|"launch"|"state"|"forget", ip, pass, code, pc} */
    static String handle(Context c, JSONObject a, Progress say) {
        String d = a.optString("do");
        String code = a.optString("code", "").toUpperCase().replaceAll("[^A-Z0-9]", ""), pc = a.optString("pc", "");
        if (!pc.matches("^\\d{1,3}(\\.\\d{1,3}){3}:\\d{2,5}$")) pc = "";
        switch (d) {
            case "install": return install(c, a.optString("ip"), a.optString("pass"), code, pc, false, say);
            case "update": return install(c, "", "", code, pc, true, say);
            case "launch": return launch(c, code, pc);
            case "forget": forget(c); return "{\"ok\":true}";
            default: return state(c);
        }
    }
}
