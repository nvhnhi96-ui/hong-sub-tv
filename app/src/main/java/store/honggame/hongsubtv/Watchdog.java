package store.honggame.hongsubtv;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

/**
 * Keeps the subtitles on: some TVs stop background apps when the picture changes to an HDMI input, and the TV
 * may have been switched off. Every minute (and when the TV starts) the subtitle service is started again if
 * "Bật phụ đề" is on and it is not running.
 */
public class Watchdog extends BroadcastReceiver {
    static final String ACTION = "store.honggame.hongsubtv.WATCH";

    static void arm(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(c, Watchdog.class).setAction(ACTION);
            int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = PendingIntent.getBroadcast(c, 7, i, fl);
            long at = SystemClock.elapsedRealtime() + 60 * 1000L;
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
            else am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
        } catch (Throwable ignored) { }
    }

    static void kick(Context c) {
        Prefs p = new Prefs(c);
        if (!p.running() || OverlayService.alive) return;
        if (Build.VERSION.SDK_INT >= 23 && !android.provider.Settings.canDrawOverlays(c)) return;
        Intent s = new Intent(c, OverlayService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(s); else c.startService(s);
        } catch (Throwable ignored) { }
    }

    @Override
    public void onReceive(Context c, Intent i) {
        kick(c);
        if (new Prefs(c).running()) arm(c);
    }
}
