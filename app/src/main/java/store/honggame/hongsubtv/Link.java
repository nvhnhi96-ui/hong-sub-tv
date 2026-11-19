package store.honggame.hongsubtv;

/** what reached this TV from Hóng Sub on the computer, shown live on the app's home screen */
final class Link {
    private Link() { }
    static volatile long pingAt, lanAt, relayAt, relayOkAt, relayErrAt;   // SystemClock.elapsedRealtime()
    static volatile String pcIp = "";

    static long now() { return android.os.SystemClock.elapsedRealtime(); }
    static long ago(long t) { return t == 0 ? Long.MAX_VALUE : now() - t; }
}
