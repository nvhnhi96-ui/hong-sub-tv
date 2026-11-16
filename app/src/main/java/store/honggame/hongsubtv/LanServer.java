package store.honggame.hongsubtv;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * Hóng Sub on the computer talks to this TV straight over the home network (no internet needed):
 *  - HTTP on port 8765: GET /ping (who am I), POST /sub (a subtitle line or a message)
 *  - UDP on port 8766: answers "HONGSUB_TV?" broadcasts so the computer can find the TV by itself
 */
final class LanServer {
    static final int HTTP_PORT = 8765, UDP_PORT = 8766;

    interface Listener { void onMessage(JSONObject j); }

    private final Context ctx;
    private final Prefs prefs;
    private final Listener listener;
    private final String boot = Long.toString(System.currentTimeMillis(), 36);
    private volatile boolean on;
    private ServerSocket http;
    private DatagramSocket udp;
    private WifiManager.MulticastLock lock;

    LanServer(Context c, Prefs p, Listener l) { ctx = c.getApplicationContext(); prefs = p; listener = l; }

    /** the TV's address on the home network, e.g. 192.168.1.50 ("" when not connected) */
    static String ip() {
        String best = "";
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback() || ni.isVirtual()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    String s = a.getHostAddress();
                    String n = ni.getName().toLowerCase();
                    if (a.isSiteLocalAddress() && (n.startsWith("wlan") || n.startsWith("eth"))) return s;
                    if (best.isEmpty()) best = s;
                }
            }
        } catch (Exception ignored) { }
        return best;
    }

    private String info() {
        try {
            return new JSONObject().put("app", "hongsubtv").put("name", Build.MANUFACTURER + " " + Build.MODEL)
                    .put("code", prefs.code()).put("ip", ip()).put("port", HTTP_PORT).put("boot", boot).toString();
        } catch (Exception e) { return "{}"; }
    }

    void start() {
        if (on) return;
        on = true;
        try {
            WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            if (wm != null) { lock = wm.createMulticastLock("hongsub"); lock.setReferenceCounted(false); lock.acquire(); }
        } catch (Exception ignored) { }
        Thread h = new Thread(this::httpLoop, "hongsub-http"); h.setDaemon(true); h.start();
        Thread u = new Thread(this::udpLoop, "hongsub-udp"); u.setDaemon(true); u.start();
    }

    void stop() {
        on = false;
        try { if (http != null) http.close(); } catch (Exception ignored) { }
        try { if (udp != null) udp.close(); } catch (Exception ignored) { }
        try { if (lock != null && lock.isHeld()) lock.release(); } catch (Exception ignored) { }
    }

    private void udpLoop() {
        while (on) {
            try {
                udp = new DatagramSocket(null);
                udp.setReuseAddress(true);
                udp.setBroadcast(true);
                udp.bind(new InetSocketAddress(UDP_PORT));
                byte[] buf = new byte[512];
                while (on) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    udp.receive(p);
                    String q = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                    if (q.startsWith("HONGSUB_TV?")) {
                        byte[] out = info().getBytes(StandardCharsets.UTF_8);
                        udp.send(new DatagramPacket(out, out.length, p.getAddress(), p.getPort()));
                    }
                }
            } catch (Exception e) {
                try { if (udp != null) udp.close(); } catch (Exception ignored) { }
                if (on) try { Thread.sleep(2000); } catch (InterruptedException ie) { return; }
            }
        }
    }

    private void httpLoop() {
        while (on) {
            try {
                http = new ServerSocket();
                http.setReuseAddress(true);
                http.bind(new InetSocketAddress(HTTP_PORT));
                while (on) {
                    Socket s = http.accept();
                    Thread t = new Thread(() -> serve(s), "hongsub-req"); t.setDaemon(true); t.start();
                }
            } catch (Exception e) {
                try { if (http != null) http.close(); } catch (Exception ignored) { }
                if (on) try { Thread.sleep(2000); } catch (InterruptedException ie) { return; }
            }
        }
    }

    private void serve(Socket s) {
        try {
            s.setSoTimeout(5000);
            InputStream in = s.getInputStream();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int c, state = 0;
            while ((c = in.read()) != -1) {           // read until the blank line after the headers
                head.write(c);
                state = (c == '\r' || c == '\n') ? state + 1 : 0;
                if (state >= 4 || head.size() > 16384) break;
                if (state == 2 && head.toString("UTF-8").endsWith("\n\n")) break;
            }
            String h = head.toString("UTF-8");
            String first = h.split("\r?\n", 2)[0];
            String[] parts = first.split(" ");
            String method = parts.length > 0 ? parts[0] : "", path = parts.length > 1 ? parts[1] : "/";
            int len = 0;
            for (String line : h.split("\r?\n")) {
                int k = line.indexOf(':');
                if (k > 0 && line.substring(0, k).trim().equalsIgnoreCase("content-length")) {
                    try { len = Integer.parseInt(line.substring(k + 1).trim()); } catch (Exception ignored) { }
                }
            }
            byte[] body = new byte[Math.max(0, Math.min(len, 4 * 1024 * 1024))];   // a voice clip from the computer can be a few hundred KB
            int got = 0;
            while (got < body.length) { int n = in.read(body, got, body.length - got); if (n < 0) break; got += n; }
            int code = 200; String out;
            if (method.equals("OPTIONS")) { code = 204; out = ""; }
            else if (path.startsWith("/ping")) out = info();
            else if (path.startsWith("/sub") && method.equals("POST")) {
                JSONObject j = new JSONObject(new String(body, 0, got, StandardCharsets.UTF_8));
                listener.onMessage(j);
                out = "{\"ok\":true}";
            } else { code = 404; out = "{\"ok\":false}"; }
            byte[] ob = out.getBytes(StandardCharsets.UTF_8);
            String resp = "HTTP/1.1 " + code + (code == 200 ? " OK" : code == 204 ? " No Content" : " Not Found") + "\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                    + "Access-Control-Allow-Private-Network: true\r\n"
                    + "Content-Length: " + ob.length + "\r\nConnection: close\r\n\r\n";
            OutputStream os = s.getOutputStream();
            os.write(resp.getBytes(StandardCharsets.UTF_8));
            os.write(ob);
            os.flush();
        } catch (Exception ignored) {
        } finally {
            try { s.close(); } catch (Exception ignored) { }
        }
    }
}
