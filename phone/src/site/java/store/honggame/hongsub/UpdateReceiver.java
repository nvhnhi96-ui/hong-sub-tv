package store.honggame.hongsub;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/** The installer's answer: when Android wants the person to confirm the update, show its "Cập nhật" screen. */
public class UpdateReceiver extends BroadcastReceiver {
    static final String ACTION = "store.honggame.hongsub.UPDATE_STATUS";

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
        // after an update the person opens Hóng Sub again (screen recording needs their OK each time)
    }
}
