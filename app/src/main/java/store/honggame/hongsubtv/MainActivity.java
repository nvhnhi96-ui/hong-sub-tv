package store.honggame.hongsubtv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** TV home screen: shows the pairing code, asks for the overlay permission and toggles the subtitle bar. */
public class MainActivity extends Activity {
    private static final int YELLOW = Color.rgb(255, 196, 0);
    private static final int INK = Color.rgb(11, 11, 13);
    private static final int MUTED = Color.rgb(160, 160, 172);

    private Prefs prefs;
    private TextView codeView;
    private TextView statusView;
    private Button permBtn, runBtn, sizeDown, sizeUp, posBtn, speakBtn, enBtn, testBtn, codeBtn;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        setContentView(buildUi());
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
        if (!canOverlay()) permBtn.requestFocus(); else runBtn.requestFocus();
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, boolean primary, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setFocusable(true);
        b.setPadding(dp(18), dp(10), dp(18), dp(10));
        GradientDrawable normal = new GradientDrawable();
        normal.setCornerRadius(dp(10));
        normal.setColor(primary ? YELLOW : Color.rgb(32, 32, 40));
        normal.setStroke(dp(2), primary ? YELLOW : Color.rgb(55, 55, 66));
        GradientDrawable focused = new GradientDrawable();
        focused.setCornerRadius(dp(10));
        focused.setColor(primary ? Color.rgb(255, 214, 80) : Color.rgb(48, 48, 58));
        focused.setStroke(dp(3), Color.WHITE);
        StateListDrawable s = new StateListDrawable();
        s.addState(new int[]{android.R.attr.state_focused}, focused);
        s.addState(new int[]{android.R.attr.state_pressed}, focused);
        s.addState(new int[]{}, normal);
        b.setBackground(s);
        b.setTextColor(primary ? INK : Color.WHITE);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.setMargins(0, 0, dp(10), dp(10));
        b.setLayoutParams(p);
        return b;
    }

    private LinearLayout row() {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        return r;
    }

    private View buildUi() {
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(INK);
        sv.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setPadding(dp(48), dp(32), dp(48), dp(32));
        sv.addView(root);

        // Left column: brand + code
        LinearLayout left = new LinearLayout(this);
        left.setOrientation(LinearLayout.VERTICAL);
        root.addView(left, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView brand = text("HÓNG SUB TV", 34, Color.WHITE, true);
        left.addView(brand);
        left.addView(text("by Hóng Game Store · honggame.store", 14, MUTED, false));

        TextView codeLbl = text("MÃ TV CỦA BẠN", 14, YELLOW, true);
        codeLbl.setPadding(0, dp(26), 0, dp(4));
        left.addView(codeLbl);
        codeView = text("", 64, Color.WHITE, true);
        codeView.setLetterSpacing(0.18f);
        left.addView(codeView);
        TextView codeHelp = text("Nhập mã này vào ô \"Gửi lên TV\" trong Hóng Sub trên máy tính.", 15, MUTED, false);
        codeHelp.setPadding(0, dp(4), 0, 0);
        left.addView(codeHelp);

        statusView = text("", 16, Color.WHITE, true);
        statusView.setPadding(0, dp(22), 0, 0);
        left.addView(statusView);

        // Right column: steps + controls
        LinearLayout right = new LinearLayout(this);
        right.setOrientation(LinearLayout.VERTICAL);
        right.setPadding(dp(32), 0, 0, 0);
        root.addView(right, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f));

        right.addView(text("1. Cho phép hiển thị trên ứng dụng khác", 17, Color.WHITE, true));
        permBtn = button("Cấp quyền", true, v -> askPermission());
        LinearLayout r1 = row(); r1.setPadding(0, dp(8), 0, dp(14)); r1.addView(permBtn); right.addView(r1);

        right.addView(text("2. Trên máy tính: mở honggame.store/hong-sub, nhập mã TV, bấm Bắt đầu dịch", 17, Color.WHITE, true));
        LinearLayout r2 = row(); r2.setPadding(0, dp(8), 0, dp(14));
        runBtn = button("Bật phụ đề", true, v -> toggleRun());
        testBtn = button("Thử hiện chữ", false, v -> restartService(OverlayService.ACTION_REFRESH));
        r2.addView(runBtn); r2.addView(testBtn); right.addView(r2);

        right.addView(text("3. Chuyển TV sang cổng HDMI của PS5 và chơi. Phụ đề hiện đè lên game.", 17, Color.WHITE, true));

        TextView setLbl = text("Tuỳ chỉnh", 15, YELLOW, true);
        setLbl.setPadding(0, dp(20), 0, dp(8));
        right.addView(setLbl);
        LinearLayout r3 = row();
        sizeDown = button("Chữ nhỏ hơn", false, v -> { prefs.textSize(prefs.textSize() - 3); applyLive(); });
        sizeUp = button("Chữ to hơn", false, v -> { prefs.textSize(prefs.textSize() + 3); applyLive(); });
        posBtn = button("", false, v -> { prefs.top(!prefs.top()); applyLive(); });
        r3.addView(sizeDown); r3.addView(sizeUp); r3.addView(posBtn);
        right.addView(r3);
        LinearLayout r4 = row();
        speakBtn = button("", false, v -> { prefs.speak(!prefs.speak()); refresh(); });
        enBtn = button("", false, v -> { prefs.showEn(!prefs.showEn()); applyLive(); });
        codeBtn = button("Đổi mã TV", false, v -> { prefs.newCode(); applyLive(); });
        r4.addView(speakBtn); r4.addView(enBtn); r4.addView(codeBtn);
        right.addView(r4);

        TextView help = text("Cần cài giúp? Gọi hoặc Zalo Hóng Game Store: 0949 099 992 · 0367 879 283", 14, MUTED, false);
        help.setPadding(0, dp(18), 0, 0);
        right.addView(help);
        return sv;
    }

    private boolean canOverlay() {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this);
    }

    private void askPermission() {
        if (Build.VERSION.SDK_INT < 23) return;
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e2) {
                statusView.setText("TV này không mở được màn hình cấp quyền. Vào Cài đặt › Ứng dụng › Hóng Sub TV › Quyền đặc biệt › Hiển thị trên ứng dụng khác.");
            }
        }
    }

    private void toggleRun() {
        if (prefs.running()) {
            Intent i = new Intent(this, OverlayService.class).setAction(OverlayService.ACTION_STOP);
            startService(i);
            prefs.running(false);
        } else {
            if (!canOverlay()) { askPermission(); return; }
            restartService(null);
        }
        refresh();
    }

    private void restartService(String action) {
        if (!canOverlay()) { askPermission(); return; }
        Intent i = new Intent(this, OverlayService.class);
        if (action != null) i.setAction(action);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        prefs.running(true);
        refresh();
    }

    private void applyLive() {
        if (prefs.running()) restartService(OverlayService.ACTION_REFRESH);
        refresh();
    }

    private void refresh() {
        codeView.setText(prefs.code());
        boolean ok = canOverlay();
        permBtn.setText(ok ? "Đã có quyền ✓" : "Cấp quyền");
        runBtn.setText(prefs.running() ? "Tắt phụ đề" : "Bật phụ đề");
        posBtn.setText(prefs.top() ? "Phụ đề: ở trên" : "Phụ đề: ở dưới");
        speakBtn.setText(prefs.speak() ? "Đọc giọng Việt: Bật" : "Đọc giọng Việt: Tắt");
        enBtn.setText(prefs.showEn() ? "Câu tiếng Anh: Hiện" : "Câu tiếng Anh: Ẩn");
        sizeDown.setText("Chữ nhỏ hơn (" + prefs.textSize() + ")");
        if (!ok) {
            statusView.setTextColor(Color.rgb(255, 159, 67));
            statusView.setText("Chưa có quyền hiển thị trên ứng dụng khác. Bấm \"Cấp quyền\", bật Hóng Sub TV rồi quay lại.");
        } else if (prefs.running()) {
            statusView.setTextColor(Color.rgb(61, 220, 132));
            statusView.setText("Đang chờ phụ đề từ máy tính. Có thể chuyển sang cổng HDMI của PS5.");
        } else {
            statusView.setTextColor(Color.WHITE);
            statusView.setText("Bấm \"Bật phụ đề\" để bắt đầu.");
        }
    }
}
