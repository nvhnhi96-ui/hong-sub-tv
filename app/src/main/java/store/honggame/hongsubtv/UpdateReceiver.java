package store.honggame.hongsubtv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/**
 * Two jobs:
 *  - the installer's answer: when Android wants the person to confirm, show its "Cập nhật" screen;
 *  - after the app was replaced by a new build: bring the subtitles back if they were on.
 */
public class UpdateReceiver extends BroadcastReceiver {
    static final String ACTION = "store.honggame.hongsubtv.UPDATE_STATUS";

    @Override
    public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if (ACTION.equals(a)) {
            int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = Build.VERSION.SDK_INT >= 33
                        ? i.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                        : i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try { c.startActivity(confirm); } catch (Exception ignored) { }
                }
            }
            return;
        }
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            Prefs p = new Prefs(c);
            if (p.running()) {
                Intent s = new Intent(c, OverlayService.class);
                try {
                    if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(s); else c.startService(s);
                } catch (Exception ignored) { }
            }
        }
    }
}
