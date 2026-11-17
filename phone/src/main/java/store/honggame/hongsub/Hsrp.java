package store.honggame.hongsub;

import java.security.SecureRandom;

/**
 * The Remote Play core (rp/mobile, built on chiaki-ng's chiaki-lib, AGPL-3.0): PS5/PS4 straight into Hóng Sub,
 * without Sony's app. The page talks to it over a WebSocket on 127.0.0.1; this only starts it and tells the page
 * where it is. Source: https://github.com/nvhnhi96-ui/hong-sub-tv/tree/main/rp/mobile
 */
final class Hsrp {
    private static boolean loaded;
    private static int port = -1;
    private static String token = "";

    static {
        try { System.loadLibrary("hsrp"); loaded = true; } catch (Throwable t) { loaded = false; }
    }

    private static native int start(int port, String token, String webRoot);

    /** {"port":..., "token":"..."} for the page, or null when this build has no Remote Play core */
    static synchronized String info() {
        if (!loaded) return null;
        if (port <= 0) {
            byte[] b = new byte[18];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x & 255));
            token = sb.toString();
            try { port = start(47123, token, ""); } catch (Throwable t) { port = -1; }
            if (port <= 0) return null;
        }
        return "{\"port\":" + port + ",\"token\":\"" + token + "\"}";
    }

    private Hsrp() { }
}
