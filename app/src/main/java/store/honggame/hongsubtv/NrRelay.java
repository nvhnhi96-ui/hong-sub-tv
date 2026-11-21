package store.honggame.hongsubtv;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The new relay (Cloudflare, relay/ in the repo): one WebSocket that brings every line the moment the computer sends
 * it, instead of asking honggame.store twice a second (which loaded the shop's website).
 *   rx: listens on the TV code.   tx: says hello / alive in the TV's own room (code + "T").
 * While rx is down the TV goes back to asking honggame.store, which passes lines on to the new relay as well.
 */
final class NrRelay {
    static final String HOST = "hongsub-relay.nvhnhi96.workers.dev";

    interface Lines { void line(JSONObject j); }

    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();

    private final Lines lines;
    private String code = "";
    private Sock rx, tx;

    NrRelay(Lines lines) { this.lines = lines; }

    /** follows the TV code: a new code opens new sockets */
    synchronized void sync(String c) {
        if (c == null) c = "";
        if (c.equals(code)) return;
        code = c;
        close();
        if (!c.matches("[A-Z0-9]{4,10}")) return;
        rx = new Sock(c, true);
        tx = new Sock(c + "T", false);
    }

    synchronized void close() {
        if (rx != null) rx.stop();
        if (tx != null) tx.stop();
        rx = tx = null;
    }

    boolean listening() { Sock s = rx; return s != null && s.open; }

    /** hello / alive into the TV's own room; false when the socket is not open */
    boolean tell(JSONObject o) { Sock s = tx; return s != null && s.send(o.toString()); }

    private final class Sock extends WebSocketListener {
        final String room; final boolean listen;
        volatile boolean open, stopped;
        volatile WebSocket ws;
        int fails;
        final Thread pinger;

        Sock(String room, boolean listen) {
            this.room = room; this.listen = listen;
            go();
            pinger = new Thread(() -> {
                while (!stopped) {
                    try { Thread.sleep(25000); } catch (InterruptedException e) { return; }
                    WebSocket w = ws; if (open && w != null) w.send("ping");
                }
            }, "hongsub-nr-ping");
            pinger.setDaemon(true);
            pinger.start();
        }

        void go() {
            if (stopped) return;
            Request r = new Request.Builder().url("wss://" + HOST + "/ws?room=" + room + (listen ? "" : "&listen=0")).build();
            ws = HTTP.newWebSocket(r, this);
        }

        void again() {
            open = false;
            if (stopped) return;
            fails++;
            long wait = Math.min(30000L, 1000L << Math.min(fails, 5));
            new Thread(() -> {
                try { Thread.sleep(wait); } catch (InterruptedException e) { return; }
                go();
            }, "hongsub-nr-again").start();
        }

        boolean send(String s) { WebSocket w = ws; return open && w != null && w.send(s); }

        void stop() {
            stopped = true; open = false;
            pinger.interrupt();
            WebSocket w = ws; if (w != null) { try { w.close(1000, "bye"); } catch (Exception ignored) { } }
        }

        @Override public void onOpen(WebSocket w, Response response) {
            if (w != ws) return;
            open = true; fails = 0;
            if (listen) Link.relayOkAt = Link.now();
        }

        @Override public void onMessage(WebSocket w, String text) {
            if (w != ws || !listen || "pong".equals(text)) return;
            try {
                JSONObject j = new JSONObject(text);
                Link.relayOkAt = Link.now();
                JSONArray items = j.optJSONArray("items");
                if (items == null) return;
                Link.relayAt = Link.now();
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.optJSONObject(i);
                    if (it != null) lines.line(it);
                }
            } catch (Exception ignored) { }
        }

        @Override public void onClosing(WebSocket w, int code, String reason) { try { w.close(1000, null); } catch (Exception ignored) { } }

        @Override public void onClosed(WebSocket w, int code, String reason) { if (w == ws) again(); }

        @Override public void onFailure(WebSocket w, Throwable t, Response response) {
            if (w != ws) return;
            if (listen) Link.relayErrAt = Link.now();
            again();
        }
    }
}
