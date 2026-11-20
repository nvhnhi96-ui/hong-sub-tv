// Hong Sub VIP: khach co ma VIP thi dich bang Claude (Anthropic) qua may chu honggame.store.
// Khoa Claude chi nam tren may chu (trang Quan tri > Hong Sub VIP), app chi gui ma VIP + ma may + cau can dich.
// Ma VIP: dung trong mot so ngay tinh tu lan kich hoat dau tien, gan voi mot may (go may trong trang quan tri de doi may).

if (!defined('HGS_VIP_MODEL')) define('HGS_VIP_MODEL', 'claude-haiku-5-5');
if (!defined('HGS_VIP_PER_MIN')) define('HGS_VIP_PER_MIN', 40);    // so cau toi da moi phut cho 1 ma (chong lam dung)
if (!defined('HGS_VIP_PER_DAY')) define('HGS_VIP_PER_DAY', 6000);  // so cau toi da moi ngay cho 1 ma

if (!function_exists('hgs_vip_table')) {
    function hgs_vip_table() {
        global $wpdb;
        $t = $wpdb->prefix . 'hgs_vip';
        if (get_option('hgs_vip_db') !== '2') {
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
            $c = $wpdb->get_charset_collate();
            dbDelta("CREATE TABLE $t (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  code varchar(20) NOT NULL,
  note varchar(160) NOT NULL DEFAULT '',
  days int(10) unsigned NOT NULL DEFAULT 30,
  dev varchar(40) NOT NULL DEFAULT '',
  created datetime NOT NULL,
  activated datetime NULL DEFAULT NULL,
  expires datetime NULL DEFAULT NULL,
  off tinyint(1) unsigned NOT NULL DEFAULT 0,
  day char(10) NOT NULL DEFAULT '',
  nday int(10) unsigned NOT NULL DEFAULT 0,
  ntotal int(10) unsigned NOT NULL DEFAULT 0,
  tin bigint(20) unsigned NOT NULL DEFAULT 0,
  tout bigint(20) unsigned NOT NULL DEFAULT 0,
  last datetime NULL DEFAULT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY code (code)
) $c;");
            update_option('hgs_vip_db', '2', false);
        }
        return $t;
    }
    function hgs_vip_key() {
        if (defined('HGS_CLAUDE_KEY') && HGS_CLAUDE_KEY) return HGS_CLAUDE_KEY;
        return (string) get_option('hgs_vip_claude_key', '');
    }
    function hgs_vip_model() {
        $m = trim((string) get_option('hgs_vip_model', ''));
        return $m !== '' ? $m : HGS_VIP_MODEL;
    }
    function hgs_vip_norm($code) {
        return substr(preg_replace('/[^A-Z0-9-]/', '', strtoupper((string) $code)), 0, 20);
    }
    function hgs_vip_new_code() {
        $a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        $s = '';
        for ($i = 0; $i < 8; $i++) $s .= $a[random_int(0, strlen($a) - 1)];
        return 'HSV-' . substr($s, 0, 4) . '-' . substr($s, 4);
    }
    function hgs_vip_ip() {
        return isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '';
    }
    function hgs_vip_err($code, $msg, $status) {
        return new WP_Error($code, $msg, array('status' => $status));
    }
    // kiem tra ma + may; lan dau thi gan may va bat dau tinh ngay
    function hgs_vip_auth($req) {
        global $wpdb;
        $t = hgs_vip_table();
        $ipk = 'hgs_vip_bad_' . md5(hgs_vip_ip());
        if ((int) get_transient($ipk) > 30) return hgs_vip_err('vip_limit', 'Nhập sai mã quá nhiều lần. Thử lại sau 1 giờ.', 429);
        $code = hgs_vip_norm($req->get_param('code'));
        $dev  = substr(preg_replace('/[^a-zA-Z0-9]/', '', (string) $req->get_param('dev')), 0, 40);
        if (strlen($dev) < 8) return hgs_vip_err('vip_bad', 'Thiếu mã máy.', 400);
        $row = $code !== '' ? $wpdb->get_row($wpdb->prepare("SELECT * FROM $t WHERE code=%s", $code)) : null;
        if (!$row) {
            set_transient($ipk, (int) get_transient($ipk) + 1, HOUR_IN_SECONDS);
            return hgs_vip_err('vip_bad', 'Mã VIP không đúng. Kiểm tra lại từng ký tự, hoặc liên hệ 0367 879 283.', 403);
        }
        if ((int) $row->off) return hgs_vip_err('vip_off', 'Mã VIP này đã bị khóa. Liên hệ 0367 879 283.', 403);
        $now = time();
        if ($row->dev === '') {
            $exp = gmdate('Y-m-d H:i:s', $now + max(1, (int) $row->days) * DAY_IN_SECONDS);
            $wpdb->query($wpdb->prepare("UPDATE $t SET dev=%s, activated=IFNULL(activated,%s), expires=IFNULL(expires,%s) WHERE id=%d AND dev=''",
                $dev, gmdate('Y-m-d H:i:s', $now), $exp, $row->id));
            $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM $t WHERE id=%d", $row->id));
        }
        if ($row->dev !== $dev) return hgs_vip_err('vip_device', 'Mã VIP này đang dùng trên máy khác. Muốn đổi máy, liên hệ 0367 879 283.', 403);
        $until = $row->expires ? strtotime($row->expires . ' UTC') : 0;
        if ($until && $until < $now) return hgs_vip_err('vip_expired', 'Mã VIP đã hết hạn ngày ' . wp_date('d/m/Y', $until) . '. Gia hạn tại Hóng Game Store, 0367 879 283.', 403);
        $row->until = $until;
        return $row;
    }
    function hgs_vip_check($req) {
        $row = hgs_vip_auth($req);
        if (is_wp_error($row)) return $row;
        return array('ok' => true, 'until' => $row->until, 'days' => (int) $row->days);
    }
    function hgs_vip_ask($req) {
        global $wpdb;
        $t = hgs_vip_table();
        $row = hgs_vip_auth($req);
        if (is_wp_error($row)) return $row;
        $key = hgs_vip_key();
        if ($key === '') return hgs_vip_err('vip_busy', 'Máy chủ VIP chưa sẵn sàng.', 503);
        // chong lam dung: so cau moi phut va moi ngay
        $mk = 'hgs_vip_m_' . $row->id . '_' . gmdate('YmdHi');
        $nm = (int) get_transient($mk);
        if ($nm >= HGS_VIP_PER_MIN) return hgs_vip_err('vip_limit', 'Dịch quá nhanh, chờ vài giây.', 429);
        set_transient($mk, $nm + 1, 120);
        $today = wp_date('Y-m-d');
        if ($row->day === $today && (int) $row->nday >= HGS_VIP_PER_DAY) return hgs_vip_err('vip_limit', 'Đã dịch rất nhiều câu hôm nay, mai dùng tiếp nhé.', 429);

        $prompt = trim(wp_check_invalid_utf8((string) $req->get_param('prompt')));
        $shape  = trim(wp_check_invalid_utf8((string) $req->get_param('shape')));
        $img    = (string) $req->get_param('img');
        if ($prompt === '' || mb_strlen($prompt) > 16000) return hgs_vip_err('vip_input', 'Câu gửi lên không hợp lệ.', 400);
        if (strlen($shape) > 2000) $shape = '';
        $content = array();
        if ($img !== '') {
            if (strlen($img) > 2800000 || !preg_match('/^[A-Za-z0-9+\/=]+$/', $img)) return hgs_vip_err('vip_input', 'Ảnh gửi lên quá lớn.', 400);
            $content[] = array('type' => 'image', 'source' => array('type' => 'base64', 'media_type' => 'image/jpeg', 'data' => $img));
        }
        $content[] = array('type' => 'text', 'text' => $prompt . ($shape !== '' ? "\n\nReply with JSON only, exactly this shape: " . $shape : "\n\nReply with JSON only."));
        $body = array(
            'model'      => hgs_vip_model(),
            'max_tokens' => 1024,
            'system'     => 'You translate video game text into natural Vietnamese for players. Follow the instructions in the message and reply with one JSON object only, no other words.',
            'messages'   => array(array('role' => 'user', 'content' => $content)),
        );
        $r = wp_remote_post('https://api.anthropic.com/v1/messages', array(
            'timeout' => 25,
            'headers' => array('x-api-key' => $key, 'anthropic-version' => '2023-06-01', 'content-type' => 'application/json'),
            'body'    => wp_json_encode($body),
        ));
        if (is_wp_error($r)) return hgs_vip_err('vip_busy', 'Máy chủ AI không trả lời, thử lại sau.', 502);
        $st = (int) wp_remote_retrieve_response_code($r);
        $j  = json_decode(wp_remote_retrieve_body($r), true);
        if ($st !== 200) {
            $em = is_array($j) && isset($j['error']['message']) ? (string) $j['error']['message'] : ('HTTP ' . $st);
            update_option('hgs_vip_last_err', gmdate('Y-m-d H:i') . ' ' . $st . ': ' . mb_substr($em, 0, 300), false);
            if (stripos($em, 'credit') !== false) return hgs_vip_err('vip_credit', 'Máy chủ VIP tạm hết lượt, shop đang xử lý.', 503);
            if ($st === 429 || $st === 529 || $st >= 500) return hgs_vip_err('vip_busy', 'AI đang bận, thử lại sau giây lát.', 503);
            return hgs_vip_err('vip_busy', 'Máy chủ VIP lỗi, shop đang xử lý.', 502);
        }
        $txt = '';
        foreach ((isset($j['content']) && is_array($j['content']) ? $j['content'] : array()) as $c) {
            if (isset($c['type']) && $c['type'] === 'text') $txt .= $c['text'];
        }
        $a = strpos($txt, '{');
        $b = strrpos($txt, '}');
        $data = ($a !== false && $b > $a) ? json_decode(substr($txt, $a, $b - $a + 1), true) : null;
        $tin  = isset($j['usage']['input_tokens']) ? (int) $j['usage']['input_tokens'] : 0;
        $tout = isset($j['usage']['output_tokens']) ? (int) $j['usage']['output_tokens'] : 0;
        $wpdb->query($wpdb->prepare(
            "UPDATE $t SET nday=IF(day=%s,nday+1,1), day=%s, ntotal=ntotal+1, tin=tin+%d, tout=tout+%d, last=%s WHERE id=%d",
            $today, $today, $tin, $tout, gmdate('Y-m-d H:i:s'), $row->id));
        return array('ok' => true, 'data' => is_array($data) ? $data : null, 'until' => $row->until);
    }
}
add_action('rest_api_init', function () {
    register_rest_route('hgs-sub/v1', '/vip/check', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'hgs_vip_check'));
    register_rest_route('hgs-sub/v1', '/vip/ask', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'hgs_vip_ask'));
});

// ---------------- Trang quan tri: Hong Sub VIP ----------------
add_action('admin_menu', function () {
    add_menu_page('Hóng Sub VIP', 'Hóng Sub VIP', 'manage_options', 'hgs-vip', 'hgs_vip_admin', 'dashicons-star-filled', 58);
});
add_action('admin_post_hgs_vip', function () {
    global $wpdb;
    if (!current_user_can('manage_options')) wp_die('no');
    check_admin_referer('hgs_vip');
    $t = hgs_vip_table();
    $do = isset($_POST['do']) ? sanitize_key($_POST['do']) : '';
    $id = isset($_POST['id']) ? (int) $_POST['id'] : 0;
    $msg = '';
    if ($do === 'key') {
        $k = trim(isset($_POST['key']) ? wp_unslash($_POST['key']) : '');
        if ($k !== '') { update_option('hgs_vip_claude_key', $k, false); $msg = 'Đã lưu khóa Claude.'; }
        $m = trim(isset($_POST['model']) ? sanitize_text_field(wp_unslash($_POST['model'])) : '');
        update_option('hgs_vip_model', $m, false);
        if ($msg === '') $msg = 'Đã lưu.';
    } elseif ($do === 'test') {
        $r = wp_remote_post('https://api.anthropic.com/v1/messages', array(
            'timeout' => 25,
            'headers' => array('x-api-key' => hgs_vip_key(), 'anthropic-version' => '2023-06-01', 'content-type' => 'application/json'),
            'body'    => wp_json_encode(array('model' => hgs_vip_model(), 'max_tokens' => 60,
                'messages' => array(array('role' => 'user', 'content' => 'Translate to Vietnamese, reply with the translation only: "Stay close to me."')))),
        ));
        if (is_wp_error($r)) $msg = 'Lỗi kết nối: ' . $r->get_error_message();
        else {
            $j = json_decode(wp_remote_retrieve_body($r), true);
            $msg = wp_remote_retrieve_response_code($r) === 200
                ? 'Khóa dùng được. Claude dịch: ' . (isset($j['content'][0]['text']) ? $j['content'][0]['text'] : '')
                : 'Khóa lỗi (' . wp_remote_retrieve_response_code($r) . '): ' . (isset($j['error']['message']) ? $j['error']['message'] : '');
        }
    } elseif ($do === 'new') {
        $n = max(1, min(50, (int) $_POST['n']));
        $days = max(1, min(3650, (int) $_POST['days']));
        $note = mb_substr(sanitize_text_field(wp_unslash($_POST['note'])), 0, 160);
        $made = array();
        for ($i = 0; $i < $n; $i++) {
            for ($try = 0; $try < 5; $try++) {
                $c = hgs_vip_new_code();
                if ($wpdb->insert($t, array('code' => $c, 'note' => $note, 'days' => $days, 'created' => gmdate('Y-m-d H:i:s')))) { $made[] = $c; break; }
            }
        }
        set_transient('hgs_vip_made', $made, 600);
        $msg = 'Đã tạo ' . count($made) . ' mã ' . $days . ' ngày.';
    } elseif ($id) {
        if ($do === 'unbind') { $wpdb->update($t, array('dev' => ''), array('id' => $id)); $msg = 'Đã gỡ máy: lần kích hoạt tới sẽ gắn máy mới.'; }
        if ($do === 'extend') {
            $d = max(1, min(3650, (int) $_POST['days']));
            $wpdb->query($wpdb->prepare("UPDATE $t SET days=days+%d, expires=IF(expires IS NULL,NULL,DATE_ADD(GREATEST(expires,UTC_TIMESTAMP()),INTERVAL %d DAY)) WHERE id=%d", $d, $d, $id));
            $msg = 'Đã gia hạn thêm ' . $d . ' ngày.';
        }
        if ($do === 'lock') { $wpdb->query($wpdb->prepare("UPDATE $t SET off=1-off WHERE id=%d", $id)); $msg = 'Đã đổi trạng thái khóa.'; }
        if ($do === 'del') { $wpdb->delete($t, array('id' => $id)); $msg = 'Đã xóa mã.'; }
    }
    wp_safe_redirect(add_query_arg(array('page' => 'hgs-vip', 'msg' => rawurlencode($msg)), admin_url('admin.php')));
    exit;
});
if (!function_exists('hgs_vip_admin')) {
    function hgs_vip_admin() {
        global $wpdb;
        if (!current_user_can('manage_options')) return;
        $t = hgs_vip_table();
        $key = hgs_vip_key();
        $rows = $wpdb->get_results("SELECT * FROM $t ORDER BY id DESC LIMIT 500");
        $today = wp_date('Y-m-d');
        $sin = 0; $sout = 0; $ntoday = 0;
        foreach ($rows as $r) { $sin += $r->tin; $sout += $r->tout; if ($r->day === $today) $ntoday += $r->nday; }
        $usd = $sin / 1e6 * 0.10 + $sout / 1e6 * 0.50;   // gia Claude Haiku 5.5 (prompt duoi 100k token)
        $f = function ($do, $id, $label, $extra = '', $confirm = '') {
            return '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="display:inline"' . ($confirm ? ' onsubmit="return confirm(\'' . esc_js($confirm) . '\')"' : '') . '>'
                . wp_nonce_field('hgs_vip', '_wpnonce', true, false) . '<input type="hidden" name="action" value="hgs_vip"><input type="hidden" name="do" value="' . esc_attr($do) . '"><input type="hidden" name="id" value="' . (int) $id . '">'
                . $extra . '<button class="button button-small">' . esc_html($label) . '</button></form> ';
        };
        echo '<div class="wrap"><h1>Hóng Sub VIP</h1>';
        if (!empty($_GET['msg'])) echo '<div class="notice notice-info"><p>' . esc_html(wp_unslash(rawurldecode($_GET['msg']))) . '</p></div>';
        $made = get_transient('hgs_vip_made');
        if ($made) { delete_transient('hgs_vip_made'); echo '<div class="notice notice-success"><p><b>Mã mới (sao chép gửi khách):</b></p><textarea readonly rows="' . min(12, count($made) + 1) . '" style="width:320px;font-family:monospace">' . esc_textarea(implode("\n", $made)) . '</textarea></div>'; }

        echo '<h2>1. Khóa Claude</h2><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">' . wp_nonce_field('hgs_vip', '_wpnonce', true, false)
            . '<input type="hidden" name="action" value="hgs_vip"><input type="hidden" name="do" value="key"><table class="form-table">'
            . '<tr><th>Khóa API (sk-ant-...)</th><td><input type="password" name="key" autocomplete="new-password" style="width:420px" placeholder="' . ($key ? 'Đã lưu, đuôi …' . esc_attr(substr($key, -4)) . ' (để trống nếu không đổi)' : 'Dán khóa tạo ở platform.claude.com') . '">'
            . (defined('HGS_CLAUDE_KEY') ? '<p class="description">Đang dùng khóa trong wp-config.php.</p>' : '') . '</td></tr>'
            . '<tr><th>Model</th><td><input name="model" value="' . esc_attr(get_option('hgs_vip_model', '')) . '" placeholder="' . esc_attr(HGS_VIP_MODEL) . '" style="width:240px"><p class="description">Để trống: ' . esc_html(HGS_VIP_MODEL) . ' (rẻ, nhanh, đọc được ảnh).</p></td></tr>'
            . '</table><button class="button button-primary">Lưu</button></form><p>' . ($key ? $f('test', 0, 'Thử khóa') : '') . '</p>';
        $le = get_option('hgs_vip_last_err', '');
        if ($le) echo '<p class="description">Lỗi gần nhất từ Claude: ' . esc_html($le) . '</p>';

        echo '<h2>2. Tạo mã VIP</h2><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">' . wp_nonce_field('hgs_vip', '_wpnonce', true, false)
            . '<input type="hidden" name="action" value="hgs_vip"><input type="hidden" name="do" value="new">'
            . 'Số mã <input type="number" name="n" value="1" min="1" max="50" style="width:60px"> · Số ngày <input type="number" name="days" value="30" min="1" style="width:70px"> (tính từ lúc khách kích hoạt) · Ghi chú <input name="note" placeholder="Tên / SĐT khách" style="width:220px"> '
            . '<button class="button button-primary">Tạo mã</button></form>';

        echo '<h2>3. Danh sách mã</h2><p>Hôm nay: <b>' . (int) $ntoday . '</b> câu · Tổng đã dùng ước tính: <b>$' . number_format($usd, 2) . '</b> (' . number_format($sin) . ' token vào, ' . number_format($sout) . ' token ra)</p>';
        echo '<table class="widefat striped"><thead><tr><th>Mã</th><th>Ghi chú</th><th>Trạng thái</th><th>Máy</th><th>Hôm nay / tổng</th><th>Dùng lần cuối</th><th></th></tr></thead><tbody>';
        if (!$rows) echo '<tr><td colspan="7">Chưa có mã nào.</td></tr>';
        foreach ($rows as $r) {
            $exp = $r->expires ? strtotime($r->expires . ' UTC') : 0;
            if ((int) $r->off) $s = '<span style="color:#b32d2e">Đã khóa</span>';
            elseif (!$r->activated) $s = 'Chưa kích hoạt (' . (int) $r->days . ' ngày)';
            elseif ($exp && $exp < time()) $s = '<span style="color:#b32d2e">Hết hạn ' . esc_html(wp_date('d/m/Y', $exp)) . '</span>';
            else $s = '<span style="color:#008a20">Còn ' . max(0, ceil(($exp - time()) / DAY_IN_SECONDS)) . ' ngày</span> (đến ' . esc_html(wp_date('d/m/Y', $exp)) . ')';
            echo '<tr><td><code>' . esc_html($r->code) . '</code></td><td>' . esc_html($r->note) . '</td><td>' . $s . '</td><td>' . ($r->dev ? '…' . esc_html(substr($r->dev, -6)) : '—') . '</td>'
                . '<td>' . ($r->day === $today ? (int) $r->nday : 0) . ' / ' . (int) $r->ntotal . '</td><td>' . ($r->last ? esc_html(wp_date('d/m H:i', strtotime($r->last . ' UTC'))) : '—') . '</td><td>'
                . ($r->dev ? $f('unbind', $r->id, 'Gỡ máy') : '')
                . $f('extend', $r->id, 'Gia hạn', '<input type="number" name="days" value="30" min="1" style="width:56px"> ')
                . $f('lock', $r->id, (int) $r->off ? 'Mở khóa' : 'Khóa')
                . $f('del', $r->id, 'Xóa', '', 'Xóa mã ' . $r->code . '?')
                . '</td></tr>';
        }
        echo '</tbody></table></div>';
    }
}
