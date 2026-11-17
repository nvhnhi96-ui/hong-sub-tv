package store.honggame.hongsub;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * "Dịch khi tắt màn hình": while Hóng Sub is translating, the phone may go to sleep (screen off) and the translation
 * still goes on: subtitles and areas to the TV, reading aloud. Holds the processor awake (partial wake lock, the screen
 * stays off) and the Wi-Fi at full speed, as a foreground service with its own notification ("Tắt" stops it).
 * The page (PS5 / PS4 inside Hóng Sub) keeps running in the WebView behind it.
 */
public class AwakeService extends Service {
    static final String ACTION_STOP = "store.honggame.hongsub.AWAKE_STOP";
    static volatile boolean running = false;
    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;

    static void set(Context c, boolean on) {
        Intent i = new Intent(c, AwakeService.class);
        if (!on) { if (running) { i.setAction(ACTION_STOP); try { c.startService(i); } catch (Exception ignored) { } } return; }
        if (running) return;
        try { if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i); } catch (Exception ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForegroundCompat();
            stopSelf();
            MainActivity.event("awake", "{\"on\":false}");
            return START_NOT_STICKY;
        }
        foreground();
        running = true;
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (cpu == null) { cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HongSub:dich"); cpu.setReferenceCounted(false); }
            if (!cpu.isHeld()) cpu.acquire(6 * 60 * 60 * 1000L);   // at most 6 hours, then the phone may sleep again
        } catch (Exception ignored) { }
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wifi == null) {
                @SuppressWarnings("deprecation") int mode = WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifi = wm.createWifiLock(mode, "HongSub:dich");
                wifi.setReferenceCounted(false);
            }
            if (!wifi.isHeld()) wifi.acquire();
        } catch (Exception ignored) { }
        MainActivity.event("awake", "{\"on\":true}");
        return START_NOT_STICKY;
    }

    private void foreground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) { nm.createNotificationChannel(new NotificationChannel("hongsub_awake", "Dịch khi tắt màn hình", NotificationManager.IMPORTANCE_LOW)); b = new Notification.Builder(this, "hongsub_awake"); }
        else b = new Notification.Builder(this);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 2, new Intent(this, AwakeService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = b.setContentTitle("Hóng Sub vẫn dịch khi tắt màn hình")
                .setContentText("Phụ đề vẫn lên TV và vẫn đọc to. Bấm Tắt để điện thoại nghỉ hẳn.")
                .setSmallIcon(android.R.drawable.ic_menu_view).setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Tắt", stop).build()).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(3, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(3, n);
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
    }

    @Override
    public void onDestroy() {
        running = false;
        try { if (cpu != null && cpu.isHeld()) cpu.release(); } catch (Exception ignored) { }
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
