package store.honggame.hongsub;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** Setup screen: Gemini keys, TV code, game context, then start screen capture. */
public class MainActivity extends Activity {
    private static final int REQ_CAPTURE = 7;
    private static final int YELLOW = Color.rgb(255, 196, 0);
    private static final int INK = Color.rgb(11, 11, 13);
    private static final int MUTED = Color.rgb(154, 154, 166);
    private static final String REMOTE_PLAY_PKG = "com.playstation.remoteplay";

    private Prefs prefs;
    private EditText keysEt, groqEt, tvEt, gameEt, notesEt;
    private TextView keyMsg, status;
    private Button startBtn;
    private final List<Button> speedBtns = new ArrayList<>();

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);
        setContentView(buildUi());
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 3);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    @Override
    protected void onPause() {
        super.onPause();
        save();
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

    private EditText input(String hint, String value, boolean multi) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(value);
        e.setTextColor(Color.WHITE);
        e.setHintTextColor(Color.rgb(90, 90, 100));
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(10));
        g.setColor(Color.rgb(20, 20, 25));
        g.setStroke(dp(1), Color.rgb(50, 50, 60));
        e.setBackground(g);
        if (multi) {
            e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            e.setMinLines(2);
        } else {
            e.setSingleLine(true);
        }
        return e;
    }

    private Button button(String label, boolean primary, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTextColor(primary ? INK : Color.WHITE);
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(10));
        g.setColor(primary ? YELLOW : Color.rgb(32, 32, 40));
        b.setBackground(g);
        b.setPadding(dp(16), dp(10), dp(16), dp(10));
        b.setOnClickListener(l);
        return b;
    }

    private LinearLayout section(LinearLayout root, String title) {
        LinearLayout s = new LinearLayout(this);
        s.setOrientation(LinearLayout.VERTICAL);
        s.setPadding(dp(16), dp(14), dp(16), dp(16));
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(14));
        g.setColor(Color.rgb(20, 20, 25));
        g.setStroke(dp(1), Color.rgb(43, 43, 52));
        s.setBackground(g);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(12), 0, 0);
        root.addView(s, lp);
        s.addView(text(title, 18, Color.WHITE, true));
        return s;
    }

    private void gap(LinearLayout l, int h) {
        View v = new View(this);
        l.addView(v, new LinearLayout.LayoutParams(1, dp(h)));
    }

    private View buildUi() {
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(INK);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(20), dp(16), dp(28));
        sv.addView(root);

        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.BOTTOM);
        TextView logo = text("HÓNG ", 30, Color.WHITE, true);
        TextView logo2 = text("SUB", 30, YELLOW, true);
        head.addView(logo);
        head.addView(logo2);
        root.addView(head);
        root.addView(text("Dịch phụ đề game sang tiếng Việt · Hóng Game Store", 13, MUTED, false));

        status = text("", 14, Color.WHITE, true);
        status.setPadding(0, dp(10), 0, 0);
        root.addView(status);

        // Keys
        LinearLayout k = section(root, "1. Mã Gemini");
        k.addView(text("Mỗi dòng 1 mã. Tạo miễn phí bằng Gmail.", 13, MUTED, false));
        gap(k, 8);
        keysEt = input("AIza...", prefs.keysRaw(), true);
        k.addView(keysEt);
        gap(k, 8);
        LinearLayout kr = new LinearLayout(this);
        kr.addView(button("Lấy mã miễn phí", false, v -> open("https://aistudio.google.com/apikey")));
        View sp = new View(this);
        kr.addView(sp, new LinearLayout.LayoutParams(dp(8), 1));
        kr.addView(button("Kiểm tra mã", false, v -> checkKeys()));
        k.addView(kr);
        gap(k, 14);
        k.addView(text("Mã Groq dự phòng (không bắt buộc), dùng khi Gemini hết lượt.", 13, MUTED, false));
        gap(k, 8);
        groqEt = input("gsk_...", prefs.groqRaw(), true);
        k.addView(groqEt);
        gap(k, 8);
        k.addView(button("Lấy mã Groq miễn phí", false, v -> open("https://console.groq.com/keys")));
        keyMsg = text("", 13, MUTED, false);
        keyMsg.setPadding(0, dp(8), 0, 0);
        k.addView(keyMsg);

        // TV
        LinearLayout t = section(root, "2. Gửi lên TV (không bắt buộc)");
        t.addView(text("Nhập mã đang hiện trên app Hóng Sub TV. Bỏ trống nếu chỉ xem trên điện thoại.", 13, MUTED, false));
        gap(t, 8);
        tvEt = input("VD: K7P2QX", prefs.tv(), false);
        tvEt.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        t.addView(tvEt);

        // Game
        LinearLayout g = section(root, "3. Game đang chơi");
        gameEt = input("Tên game, VD: God of War Ragnarök", prefs.game(), false);
        g.addView(gameEt);
        gap(g, 8);
        notesEt = input("Nhân vật, cách xưng hô (không bắt buộc)", prefs.notes(), true);
        g.addView(notesEt);

        // Options
        LinearLayout o = section(root, "Đọc & hiển thị");
        Switch speak = new Switch(this);
        speak.setText("Đọc to bằng giọng Việt");
        speak.setTextColor(Color.WHITE);
        speak.setChecked(prefs.speak());
        speak.setOnCheckedChangeListener((CompoundButton b, boolean on) -> prefs.speak(on));
        o.addView(speak);
        Switch en = new Switch(this);
        en.setText("Hiện câu tiếng Anh gốc");
        en.setTextColor(Color.WHITE);
        en.setChecked(prefs.showEn());
        en.setOnCheckedChangeListener((CompoundButton b, boolean on) -> prefs.showEn(on));
        o.addView(en);
        gap(o, 8);
        o.addView(text("Tốc độ quét", 13, MUTED, true));
        LinearLayout speeds = new LinearLayout(this);
        int[] vals = {1200, 700, 400};
        String[] names = {"Tiết kiệm", "Vừa", "Nhanh"};
        for (int i = 0; i < 3; i++) {
            final int val = vals[i];
            Button sb = button(names[i], false, v -> { prefs.interval(val); refresh(); });
            sb.setTag(val);
            speedBtns.add(sb);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            lp.setMargins(i == 0 ? 0 : dp(6), dp(6), 0, 0);
            speeds.addView(sb, lp);
        }
        o.addView(speeds);

        // Start
        gap(root, 16);
        startBtn = button("Bắt đầu", true, v -> start());
        startBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        root.addView(startBtn, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56)));
        TextView how = text("Bấm Bắt đầu, cho phép hiển thị trên ứng dụng khác và cho phép ghi màn hình. App sẽ mở PS Remote Play. Trong game: bấm \"Khung\" trên thanh nổi để kéo khung trùm lên phụ đề, rồi bấm \"Dịch\".", 13, MUTED, false);
        how.setPadding(0, dp(10), 0, 0);
        root.addView(how);
        gap(root, 10);
        root.addView(button("Xem hướng dẫn trên honggame.store", false, v -> open("https://honggame.store/hong-sub/#huong-dan")));
        TextView shop = text("Cần cài giúp? Gọi/Zalo 0949 099 992 · 0367 879 283", 13, MUTED, false);
        shop.setPadding(0, dp(12), 0, 0);
        root.addView(shop);
        return sv;
    }

    private void open(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (ActivityNotFoundException ignored) { }
    }

    private void save() {
        prefs.keysRaw(keysEt.getText().toString());
        prefs.groqRaw(groqEt.getText().toString());
        prefs.tv(tvEt.getText().toString());
        prefs.game(gameEt.getText().toString());
        prefs.notes(notesEt.getText().toString());
    }

    private void refresh() {
        for (Button b : speedBtns) {
            boolean on = ((Integer) b.getTag()) == prefs.interval();
            GradientDrawable g = new GradientDrawable();
            g.setCornerRadius(dp(10));
            g.setColor(on ? Color.rgb(60, 60, 72) : Color.rgb(32, 32, 40));
            if (on) g.setStroke(dp(2), YELLOW);
            b.setBackground(g);
        }
        boolean run = CaptureService.running;
        startBtn.setText(run ? "Tắt Hóng Sub" : "Bắt đầu");
        status.setTextColor(run ? Color.rgb(61, 220, 132) : Color.WHITE);
        status.setText(run ? "Đang chạy. Mở PS Remote Play và dùng thanh nổi có chữ H." : "");
    }

    private void checkKeys() {
        save();
        final List<String> ks = prefs.keys();
        final List<String> gs = prefs.groqKeys();
        if (ks.isEmpty() && gs.isEmpty()) {
            keyMsg.setTextColor(Color.rgb(255, 92, 92));
            keyMsg.setText("Chưa có mã. Bấm \"Lấy mã miễn phí\", tạo mã Gemini rồi dán vào ô trên.");
            return;
        }
        keyMsg.setTextColor(MUTED);
        keyMsg.setText("Đang kiểm tra " + (ks.size() + gs.size()) + " mã...");
        new Thread(() -> {
            int good = 0, ggood = 0;
            List<String> models = null, gmodels = null;
            StringBuilder errs = new StringBuilder();
            for (int i = 0; i < ks.size(); i++) {
                try {
                    List<String> m2 = Gemini.listModels(ks.get(i));
                    good++;
                    if (models == null && !m2.isEmpty()) models = m2;
                } catch (Exception e) {
                    errs.append(" · Gemini ").append(i + 1).append(": ").append(e.getMessage());
                }
            }
            for (int i = 0; i < gs.size(); i++) {
                try {
                    List<String> g2 = Groq.listModels(gs.get(i));
                    ggood++;
                    if (gmodels == null && !g2.isEmpty()) gmodels = g2;
                } catch (Exception e) {
                    errs.append(" · Groq ").append(i + 1).append(": ").append(e.getMessage());
                }
            }
            final int ok = good, gok = ggood;
            final List<String> ms = models, gms = gmodels;
            final String er = errs.toString();
            runOnUiThread(() -> {
                if (ok == 0 && gok == 0) {
                    keyMsg.setTextColor(Color.rgb(255, 92, 92));
                    keyMsg.setText("Không dùng được mã nào" + er + ". Kiểm tra đã sao chép đủ mã chưa.");
                    return;
                }
                if (ms != null) prefs.models(ms);
                if (gms != null) prefs.groqModels(gms);
                StringBuilder sb = new StringBuilder("Dùng được:");
                if (!ks.isEmpty()) sb.append(" Gemini ").append(ok).append("/").append(ks.size()).append(ok > 0 ? " (" + prefs.models().get(0) + ")" : "");
                if (!gs.isEmpty()) sb.append(" · Groq ").append(gok).append("/").append(gs.size());
                keyMsg.setTextColor(ok > 0 ? Color.rgb(61, 220, 132) : Color.rgb(255, 159, 67));
                keyMsg.setText(sb.toString() + er);
            });
        }).start();
    }

    private void start() {
        save();
        if (CaptureService.running) {
            startService(new Intent(this, CaptureService.class).setAction(CaptureService.ACTION_STOP));
            CaptureService.running = false;
            refresh();
            return;
        }
        if (prefs.keys().isEmpty() && prefs.groqKeys().isEmpty()) {
            keyMsg.setTextColor(Color.rgb(255, 92, 92));
            keyMsg.setText("Nhập mã Gemini trước khi bắt đầu.");
            keysEt.requestFocus();
            return;
        }
        if (!Settings.canDrawOverlays(this)) {
            status.setTextColor(Color.rgb(255, 159, 67));
            status.setText("Cho phép Hóng Sub \"Hiển thị trên ứng dụng khác\", rồi quay lại bấm Bắt đầu.");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e) {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            }
            return;
        }
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_CAPTURE) return;
        if (resultCode != RESULT_OK || data == null) {
            status.setTextColor(Color.rgb(255, 159, 67));
            status.setText("Cần cho phép ghi màn hình thì Hóng Sub mới đọc được phụ đề.");
            return;
        }
        Intent svc = new Intent(this, CaptureService.class)
                .putExtra(CaptureService.EXTRA_CODE, resultCode)
                .putExtra(CaptureService.EXTRA_DATA, data);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
        Intent rp = getPackageManager().getLaunchIntentForPackage(REMOTE_PLAY_PKG);
        if (rp != null) {
            startActivity(rp);
        } else {
            status.setTextColor(Color.rgb(255, 159, 67));
            status.setText("Máy chưa cài PS Remote Play. Cài từ Google Play rồi mở lên, thanh nổi Hóng Sub vẫn đang chạy.");
            open("https://play.google.com/store/apps/details?id=" + REMOTE_PLAY_PKG);
        }
    }
}
