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
        if (get_option('hgs_vip_db') !== '4') {
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
            $r = $wpdb->prefix . 'hgs_vip_reg';
            dbDelta("CREATE TABLE $r (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  token char(32) NOT NULL,
  name varchar(80) NOT NULL DEFAULT '',
  phone varchar(20) NOT NULL DEFAULT '',
  plan varchar(60) NOT NULL DEFAULT '',
  days int(10) unsigned NOT NULL DEFAULT 30,
  price varchar(40) NOT NULL DEFAULT '',
  note varchar(300) NOT NULL DEFAULT '',
  dev varchar(40) NOT NULL DEFAULT '',
  ip varchar(64) NOT NULL DEFAULT '',
  created datetime NOT NULL,
  status tinyint(1) unsigned NOT NULL DEFAULT 0,
  code varchar(20) NOT NULL DEFAULT '',
  PRIMARY KEY  (id),
  KEY status (status,id),
  KEY dev (dev)
) $c;");
            $o = $wpdb->prefix . 'hgs_vip_order';
            dbDelta("CREATE TABLE $o (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  token char(32) NOT NULL,
  pay varchar(12) NOT NULL,
  dev varchar(40) NOT NULL DEFAULT '',
  plan varchar(60) NOT NULL DEFAULT '',
  days int(10) unsigned NOT NULL DEFAULT 30,
  amount int(10) unsigned NOT NULL DEFAULT 0,
  phone varchar(20) NOT NULL DEFAULT '',
  ip varchar(64) NOT NULL DEFAULT '',
  created datetime NOT NULL,
  status tinyint(1) unsigned NOT NULL DEFAULT 0,
  paid datetime NULL DEFAULT NULL,
  got int(10) unsigned NOT NULL DEFAULT 0,
  ref varchar(80) NOT NULL DEFAULT '',
  code varchar(20) NOT NULL DEFAULT '',
  PRIMARY KEY  (id),
  UNIQUE KEY pay (pay),
  KEY dev (dev)
) $c;");
            update_option('hgs_vip_db', '4', false);
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
    function hgs_vip_reg_table() {
        global $wpdb;
        hgs_vip_table();
        return $wpdb->prefix . 'hgs_vip_reg';
    }
    // cac goi VIP shop dang ban (ten, so ngay, gia) - sua o trang quan tri
    function hgs_vip_plans() {
        $p = get_option('hgs_vip_plans', null);
        if (!is_array($p) || !$p) $p = array(
            array('name' => '1 tháng', 'days' => 30, 'price' => ''),
            array('name' => '3 tháng', 'days' => 90, 'price' => ''),
            array('name' => '12 tháng', 'days' => 365, 'price' => ''),
        );
        $out = array();
        foreach ($p as $x) {
            if (!empty($x['name']) && (int) $x['days'] > 0) $out[] = array('name' => (string) $x['name'], 'days' => (int) $x['days'], 'price' => (string) $x['price']);
        }
        return $out;
    }
    function hgs_vip_plans_api() {
        $pl = hgs_vip_plans();
        $buy = get_option('hgs_vip_autopay', '') === '1' && hgs_vip_bank();
        foreach ($pl as $i => $x) { $pl[$i]['id'] = $i; $pl[$i]['amount'] = hgs_vip_amount($x['price']); }
        return array('ok' => true, 'plans' => $pl, 'pay' => (string) get_option('hgs_vip_pay', ''), 'buy' => (bool) $buy);
    }
    // khach dang ky VIP ngay trong app: luu lai, shop goi / nhan Zalo xac nhan, bam "Cap ma" la VIP tu bat tren may khach
    function hgs_vip_register($req) {
        global $wpdb;
        $r = hgs_vip_reg_table();
        $ipk = 'hgs_vip_rg_' . md5(hgs_vip_ip());
        if ((int) get_transient($ipk) >= 6) return hgs_vip_err('vip_limit', 'Bạn đã gửi nhiều đăng ký. Shop sẽ liên hệ sớm, hoặc nhắn Zalo 0367 879 283.', 429);
        $name  = mb_substr(trim(sanitize_text_field((string) $req->get_param('name'))), 0, 80);
        $phone = preg_replace('/\D/', '', (string) $req->get_param('phone'));
        if (strpos($phone, '84') === 0 && strlen($phone) >= 11) $phone = '0' . substr($phone, 2);
        $note  = mb_substr(trim(sanitize_text_field((string) $req->get_param('note'))), 0, 300);
        $dev   = substr(preg_replace('/[^a-zA-Z0-9]/', '', (string) $req->get_param('dev')), 0, 40);
        $pl    = hgs_vip_plans();
        $pi    = (int) $req->get_param('plan');
        if (mb_strlen($name) < 2) return hgs_vip_err('vip_input', 'Nhập họ tên của bạn.', 400);
        if (!preg_match('/^0\d{9,10}$/', $phone)) return hgs_vip_err('vip_input', 'Số điện thoại chưa đúng (VD: 0912345678).', 400);
        if (!isset($pl[$pi])) return hgs_vip_err('vip_input', 'Chọn một gói VIP.', 400);
        if (strlen($dev) < 8) return hgs_vip_err('vip_input', 'Thiếu mã máy.', 400);
        $tok = wp_generate_password(32, false, false);
        $wpdb->insert($r, array('token' => $tok, 'name' => $name, 'phone' => $phone, 'plan' => $pl[$pi]['name'], 'days' => $pl[$pi]['days'],
            'price' => $pl[$pi]['price'], 'note' => $note, 'dev' => $dev, 'ip' => hgs_vip_ip(), 'created' => gmdate('Y-m-d H:i:s')));
        $id = (int) $wpdb->insert_id;
        if (!$id) return hgs_vip_err('vip_busy', 'Chưa gửi được đăng ký, thử lại sau.', 500);
        set_transient($ipk, (int) get_transient($ipk) + 1, HOUR_IN_SECONDS);
        $to = get_option('hgs_vip_mail', '') ?: get_option('admin_email');
        if ($to) wp_mail($to, '[Hóng Sub VIP] Đăng ký mới: ' . $name . ' - ' . $phone,
            "Khách đăng ký gói VIP Hóng Sub\n\nHọ tên: $name\nSĐT/Zalo: $phone\nGói: " . $pl[$pi]['name'] . ($pl[$pi]['price'] !== '' ? ' (' . $pl[$pi]['price'] . ')' : '') . "\nGhi chú: $note\n\nDuyệt và cấp mã: " . admin_url('admin.php?page=hgs-vip'));
        return array('ok' => true, 'id' => $id, 'token' => $tok, 'pay' => (string) get_option('hgs_vip_pay', ''));
    }
    function hgs_vip_reg_status($req) {
        global $wpdb;
        $r = hgs_vip_reg_table();
        $t = hgs_vip_table();
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM $r WHERE id=%d", (int) $req->get_param('id')));
        $dev = substr(preg_replace('/[^a-zA-Z0-9]/', '', (string) $req->get_param('dev')), 0, 40);
        if (!$row || !hash_equals($row->token, (string) $req->get_param('token')) || $row->dev !== $dev) return hgs_vip_err('vip_gone', 'Không tìm thấy đăng ký.', 404);
        if ((int) $row->status === 2) return array('ok' => true, 'status' => 'no');
        if ((int) $row->status !== 1 || $row->code === '') return array('ok' => true, 'status' => 'wait');
        $c = $wpdb->get_row($wpdb->prepare("SELECT * FROM $t WHERE code=%s", $row->code));
        return array('ok' => true, 'status' => 'done', 'code' => $row->code, 'until' => ($c && $c->expires) ? strtotime($c->expires . ' UTC') : 0);
    }
    function hgs_vip_order_table() {
        global $wpdb;
        hgs_vip_table();
        return $wpdb->prefix . 'hgs_vip_order';
    }
    // gia dang chu ("49.000d", "49k") -> so tien
    function hgs_vip_amount($price) {
        $s = strtolower((string) $price);
        $n = (int) preg_replace('/\D/', '', $s);
        if ($n > 0 && $n < 10000 && strpos($s, 'k') !== false) $n *= 1000;
        return $n >= 1000 ? $n : 0;
    }
    // ten ngan hang day du ("Ngan hang TMCP Quan doi") -> ma BIN de tao QR
    function hgs_vip_bin($bank) {
        $b = trim((string) $bank);
        if (preg_match('/^\d{6}$/', $b)) return $b;
        $s = strtolower(remove_accents($b));
        $map = array(
            'quan doi' => '970422', 'mbbank' => '970422', 'mb bank' => '970422', 'ngoai thuong' => '970436', 'vietcombank' => '970436', 'cong thuong' => '970415', 'vietinbank' => '970415',
            'dau tu va phat trien' => '970418', 'bidv' => '970418', 'nong nghiep' => '970405', 'agribank' => '970405', 'ky thuong' => '970407', 'techcombank' => '970407',
            'a chau' => '970416', 'acb' => '970416', 'thinh vuong' => '970432', 'vpbank' => '970432', 'tien phong' => '970423', 'tpbank' => '970423',
            'sai gon thuong tin' => '970403', 'sacombank' => '970403', 'quoc te' => '970441', 'vib' => '970441', 'phat trien thanh pho ho chi minh' => '970437', 'hdbank' => '970437',
            'sai gon - ha noi' => '970443', 'sai gon ha noi' => '970443', 'shb' => '970443', 'phuong dong' => '970448', 'ocb' => '970448', 'hang hai' => '970426', 'msb' => '970426',
            'xuat nhap khau' => '970431', 'eximbank' => '970431', 'dong nam a' => '970440', 'seabank' => '970440', 'loc phat' => '970449', 'lpbank' => '970449', 'buu dien lien viet' => '970449',
            'an binh' => '970425', 'abbank' => '970425', 'bac a' => '970409', 'nam a' => '970428', 'kien long' => '970452', 'viet a' => '970427', 'bao viet' => '970438', 'cake' => '546034', 'timo' => '963388',
        );
        foreach ($map as $k => $v) if (strpos($s, $k) !== false) return $v;
        $map2 = array('MB' => '970422', 'VCB' => '970436', 'CTG' => '970415', 'ICB' => '970415', 'BIDV' => '970418', 'VBA' => '970405', 'TCB' => '970407', 'ACB' => '970416', 'VPB' => '970432', 'TPB' => '970423', 'STB' => '970403');
        $u = strtoupper($b);
        return isset($map2[$u]) ? $map2[$u] : $b;
    }
    // tai khoan nhan tien: lay tu cai dat VietQR cua web (WooCommerce), hoac o trang quan tri
    function hgs_vip_bank() {
        $own = get_option('hgs_vip_bank', array());
        if (is_array($own) && !empty($own['acc']) && !empty($own['bank'])) return $own + array('src' => 'Hóng Sub VIP');
        global $wpdb;
        $cands = array('woocommerce_vietqr_accounts', 'vietqr_accounts', 'woocommerce_vietqr_settings');
        foreach ($wpdb->get_col("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE '%vietqr%' LIMIT 20") as $nm) if (!in_array($nm, $cands, true)) $cands[] = $nm;
        foreach ($cands as $nm) {
            $v = get_option($nm);
            $list = array();
            if (is_array($v)) { $list = isset($v['account_number']) ? array($v) : $v; }
            foreach ($list as $a) {
                if (!is_array($a)) continue;
                $acc = isset($a['account_number']) ? $a['account_number'] : (isset($a['vietqr_account_number']) ? $a['vietqr_account_number'] : '');
                $bank = isset($a['bank_name']) ? $a['bank_name'] : (isset($a['vietqr_bank_name']) ? $a['vietqr_bank_name'] : '');
                $name = isset($a['account_name']) ? $a['account_name'] : (isset($a['vietqr_account_name']) ? $a['vietqr_account_name'] : '');
                if ($acc !== '' && $bank !== '') return array('bank' => (string) $bank, 'acc' => preg_replace('/\s+/', '', (string) $acc), 'name' => (string) $name, 'src' => 'VietQR (' . $nm . ')');
            }
        }
        return array();
    }
    // khach bam "Mua ngay" trong app: tao don cho, tra ve ma QR (so tien + noi dung chuyen khoan dien san)
    function hgs_vip_buy($req) {
        global $wpdb;
        $o = hgs_vip_order_table();
        $ipk = 'hgs_vip_buy_' . md5(hgs_vip_ip());
        if ((int) get_transient($ipk) >= 15) return hgs_vip_err('vip_limit', 'Bạn đã tạo nhiều đơn. Thử lại sau, hoặc nhắn Zalo 0367 879 283.', 429);
        $dev = substr(preg_replace('/[^a-zA-Z0-9]/', '', (string) $req->get_param('dev')), 0, 40);
        if (strlen($dev) < 8) return hgs_vip_err('vip_input', 'Thiếu mã máy.', 400);
        $pl = hgs_vip_plans();
        $pi = (int) $req->get_param('plan');
        if (!isset($pl[$pi])) return hgs_vip_err('vip_input', 'Chọn một gói VIP.', 400);
        $amount = hgs_vip_amount($pl[$pi]['price']);
        $bank = hgs_vip_bank();
        if (!$amount || !$bank || get_option('hgs_vip_autopay', '') !== '1') return hgs_vip_err('vip_nobuy', 'Gói này chưa mua tự động được. Để lại số điện thoại để shop liên hệ, hoặc nhắn Zalo 0367 879 283.', 409);
        $phone = preg_replace('/\D/', '', (string) $req->get_param('phone'));
        // dang co don cho cua may nay, cung goi: dung lai (khach bam Mua nhieu lan)
        $old = $wpdb->get_row($wpdb->prepare("SELECT * FROM $o WHERE dev=%s AND status=0 AND days=%d AND amount=%d AND created > %s ORDER BY id DESC LIMIT 1",
            $dev, $pl[$pi]['days'], $amount, gmdate('Y-m-d H:i:s', time() - 20 * HOUR_IN_SECONDS)));
        if ($old) { $id = (int) $old->id; $tok = $old->token; $pay = $old->pay; }
        else {
            $id = 0;
            for ($try = 0; $try < 8 && !$id; $try++) {
                $pay = 'HSV' . random_int(100000, 999999);
                $tok = wp_generate_password(32, false, false);
                if ($wpdb->insert($o, array('token' => $tok, 'pay' => $pay, 'dev' => $dev, 'plan' => $pl[$pi]['name'], 'days' => $pl[$pi]['days'], 'amount' => $amount,
                    'phone' => substr($phone, 0, 20), 'ip' => hgs_vip_ip(), 'created' => gmdate('Y-m-d H:i:s')))) $id = (int) $wpdb->insert_id;
            }
            if (!$id) return hgs_vip_err('vip_busy', 'Chưa tạo được đơn, thử lại sau.', 500);
            set_transient($ipk, (int) get_transient($ipk) + 1, HOUR_IN_SECONDS);
        }
        $qr = 'https://img.vietqr.io/image/' . rawurlencode(hgs_vip_bin($bank['bank'])) . '-' . rawurlencode($bank['acc']) . '-compact2.png?amount=' . $amount . '&addInfo=' . rawurlencode($pay) . '&accountName=' . rawurlencode($bank['name']);
        return array('ok' => true, 'id' => $id, 'token' => $tok, 'pay' => $pay, 'amount' => $amount, 'plan' => $pl[$pi]['name'], 'qr' => $qr,
            'bank' => $bank['bank'], 'acc' => $bank['acc'], 'name' => $bank['name']);
    }
    function hgs_vip_order_status($req) {
        global $wpdb;
        $o = hgs_vip_order_table();
        $t = hgs_vip_table();
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM $o WHERE id=%d", (int) $req->get_param('id')));
        $dev = substr(preg_replace('/[^a-zA-Z0-9]/', '', (string) $req->get_param('dev')), 0, 40);
        if (!$row || !hash_equals($row->token, (string) $req->get_param('token')) || $row->dev !== $dev) return hgs_vip_err('vip_gone', 'Không tìm thấy đơn.', 404);
        if ((int) $row->status === 1 && $row->code !== '') {
            $c = $wpdb->get_row($wpdb->prepare("SELECT * FROM $t WHERE code=%s", $row->code));
            return array('ok' => true, 'status' => 'done', 'code' => $row->code, 'until' => ($c && $c->expires) ? strtotime($c->expires . ' UTC') : 0);
        }
        if ((int) $row->status === 3) return array('ok' => true, 'status' => 'short', 'got' => (int) $row->got, 'amount' => (int) $row->amount);
        if (strtotime($row->created . ' UTC') < time() - 3 * DAY_IN_SECONDS) return array('ok' => true, 'status' => 'old');
        return array('ok' => true, 'status' => 'wait');
    }
    // cap ma VIP cho mot don da tra tien: gan voi may da mua, bat dau tinh ngay luon
    function hgs_vip_fulfil($row, $got, $ref) {
        global $wpdb;
        $o = hgs_vip_order_table();
        $t = hgs_vip_table();
        $now = time();
        // may nay dang co VIP con han: cong them ngay vao ma do
        $cur = $wpdb->get_row($wpdb->prepare("SELECT * FROM $t WHERE dev=%s AND off=0 AND expires > UTC_TIMESTAMP() ORDER BY expires DESC LIMIT 1", $row->dev));
        if ($cur) {
            $wpdb->query($wpdb->prepare("UPDATE $t SET days=days+%d, expires=DATE_ADD(expires, INTERVAL %d DAY) WHERE id=%d", $row->days, $row->days, $cur->id));
            $code = $cur->code;
        } else {
            $code = '';
            for ($try = 0; $try < 6 && $code === ''; $try++) {
                $c = hgs_vip_new_code();
                if ($wpdb->insert($t, array('code' => $c, 'note' => 'Mua tự động ' . $row->pay . ' (' . $row->plan . ')' . ($row->phone ? ' ' . $row->phone : ''), 'days' => $row->days, 'dev' => $row->dev,
                    'created' => gmdate('Y-m-d H:i:s', $now), 'activated' => gmdate('Y-m-d H:i:s', $now), 'expires' => gmdate('Y-m-d H:i:s', $now + $row->days * DAY_IN_SECONDS)))) $code = $c;
            }
        }
        $wpdb->update($o, array('status' => 1, 'paid' => gmdate('Y-m-d H:i:s', $now), 'got' => (int) $got, 'ref' => substr((string) $ref, 0, 80), 'code' => $code), array('id' => $row->id));
        return $code;
    }
    // SePay goi vao day moi khi co tien vao tai khoan. Noi dung co "HSVxxxxxx" va du tien -> tu cap VIP.
    function hgs_vip_sepay($req) {
        global $wpdb;
        $key = (string) get_option('hgs_vip_sepay_key', '');
        $auth = (string) $req->get_header('authorization');
        if ($key === '' || stripos($auth, 'apikey ') !== 0 || !hash_equals($key, trim(substr($auth, 7)))) return new WP_REST_Response(array('success' => false, 'message' => 'unauthorized'), 401);
        $d = $req->get_json_params();
        if (!is_array($d)) $d = $req->get_params();
        update_option('hgs_vip_sepay_last', gmdate('Y-m-d H:i:s') . ' | ' . mb_substr((string) (isset($d['content']) ? $d['content'] : ''), 0, 80) . ' | ' . (int) (isset($d['transferAmount']) ? $d['transferAmount'] : 0), false);
        if (!isset($d['transferType']) || $d['transferType'] !== 'in') return array('success' => true);
        $txt = strtoupper((isset($d['code']) ? $d['code'] : '') . ' ' . (isset($d['content']) ? $d['content'] : '') . ' ' . (isset($d['description']) ? $d['description'] : ''));
        if (!preg_match('/HSV\s?(\d{6})(?!\d)/', $txt, $m)) return array('success' => true);
        $o = hgs_vip_order_table();
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM $o WHERE pay=%s", 'HSV' . $m[1]));
        if (!$row) return array('success' => true);
        $ref = (string) (isset($d['id']) ? $d['id'] : '') . '/' . (string) (isset($d['referenceCode']) ? $d['referenceCode'] : '');
        if ((int) $row->status === 1 || ($row->ref !== '' && $row->ref === $ref)) return array('success' => true);   // da xu ly roi (SePay gui lai)
        $got = (int) $row->got + (int) (isset($d['transferAmount']) ? $d['transferAmount'] : 0);
        if ($got < (int) $row->amount) {   // chuyen thieu: ghi lai, doi chuyen them
            $wpdb->update($o, array('status' => 3, 'got' => $got, 'ref' => substr($ref, 0, 80)), array('id' => $row->id));
            return array('success' => true);
        }
        hgs_vip_fulfil($row, $got, $ref);
        return array('success' => true);
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
            'system'     => $req->get_param('mode') === 'hint'
                ? 'You are a friendly video game guide for Vietnamese players. Look at the screenshot, work out the current quest, objective or puzzle, and help the player get past it. Follow the instructions in the message and reply with one JSON object only, no other words.'
                : 'You translate video game text into natural Vietnamese for players. Follow the instructions in the message and reply with one JSON object only, no other words.',
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
    register_rest_route('hgs-sub/v1', '/vip/plans', array('methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => 'hgs_vip_plans_api'));
    register_rest_route('hgs-sub/v1', '/vip/register', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'hgs_vip_register'));
    register_rest_route('hgs-sub/v1', '/vip/buy', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'hgs_vip_buy'));
    register_rest_route('hgs-sub/v1', '/vip/order', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'hgs_vip_order_status'));
    register_rest_route('hgs-sub/v1', '/vip/sepay', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'hgs_vip_sepay'));
    register_rest_route('hgs-sub/v1', '/vip/reg', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'hgs_vip_reg_status'));
});

// ---------------- Trang quan tri: Hong Sub VIP ----------------
add_action('admin_menu', function () {
    global $wpdb;
    $n = 0;
    if (get_option('hgs_vip_db') === '4') $n = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}hgs_vip_reg WHERE status=0");
    add_menu_page('Hóng Sub VIP', 'Hóng Sub VIP' . ($n ? ' <span class="awaiting-mod">' . $n . '</span>' : ''), 'manage_options', 'hgs-vip', 'hgs_vip_admin', 'dashicons-star-filled', 58);
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
    } elseif ($do === 'plans') {
        $pl = array();
        $names = isset($_POST['pn']) ? (array) $_POST['pn'] : array();
        foreach ($names as $i => $nm) {
            $nm = mb_substr(sanitize_text_field(wp_unslash($nm)), 0, 60);
            $dd = isset($_POST['pd'][$i]) ? (int) $_POST['pd'][$i] : 0;
            $pr = isset($_POST['pp'][$i]) ? mb_substr(sanitize_text_field(wp_unslash($_POST['pp'][$i])), 0, 40) : '';
            if ($nm !== '' && $dd > 0) $pl[] = array('name' => $nm, 'days' => $dd, 'price' => $pr);
        }
        update_option('hgs_vip_plans', $pl, false);
        update_option('hgs_vip_pay', mb_substr(sanitize_textarea_field(wp_unslash(isset($_POST['pay']) ? $_POST['pay'] : '')), 0, 600), false);
        update_option('hgs_vip_mail', sanitize_email(wp_unslash(isset($_POST['mail']) ? $_POST['mail'] : '')), false);
        $msg = 'Đã lưu gói và giá.';
    } elseif ($do === 'approve' && $id) {
        $r = hgs_vip_reg_table();
        $g = $wpdb->get_row($wpdb->prepare("SELECT * FROM $r WHERE id=%d", $id));
        if ($g && (int) $g->status === 0) {
            $days = max(1, min(3650, isset($_POST['days']) ? (int) $_POST['days'] : (int) $g->days));
            $now = time();
            for ($try = 0; $try < 5; $try++) {
                $c = hgs_vip_new_code();
                if ($wpdb->insert($t, array('code' => $c, 'note' => $g->name . ' ' . $g->phone . ' (' . $g->plan . ')', 'days' => $days, 'dev' => $g->dev,
                    'created' => gmdate('Y-m-d H:i:s', $now), 'activated' => gmdate('Y-m-d H:i:s', $now), 'expires' => gmdate('Y-m-d H:i:s', $now + $days * DAY_IN_SECONDS)))) {
                    $wpdb->update($r, array('status' => 1, 'code' => $c), array('id' => $id));
                    $msg = 'Đã cấp mã ' . $c . ' (' . $days . ' ngày) cho ' . $g->name . '. VIP tự bật trên máy khách trong khoảng 1 phút.';
                    break;
                }
            }
        }
    } elseif ($do === 'sepay') {
        if (!empty($_POST['newkey']) || get_option('hgs_vip_sepay_key', '') === '') update_option('hgs_vip_sepay_key', wp_generate_password(40, false, false), false);
        update_option('hgs_vip_autopay', !empty($_POST['autopay']) ? '1' : '', false);
        $b = array('bank' => sanitize_text_field(wp_unslash(isset($_POST['bk']) ? $_POST['bk'] : '')), 'acc' => preg_replace('/\s+/', '', sanitize_text_field(wp_unslash(isset($_POST['ba']) ? $_POST['ba'] : ''))), 'name' => sanitize_text_field(wp_unslash(isset($_POST['bn']) ? $_POST['bn'] : '')));
        if (!empty($_POST['bclear'])) delete_option('hgs_vip_bank');
        elseif ($b['bank'] !== '' && $b['acc'] !== '') update_option('hgs_vip_bank', $b, false);
        $msg = 'Đã lưu cài đặt thanh toán tự động.';
    } elseif ($do === 'paid' && $id) {
        $o = hgs_vip_order_table();
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM $o WHERE id=%d", $id));
        if ($row && (int) $row->status !== 1) { $c = hgs_vip_fulfil($row, $row->amount, 'shop xác nhận tay'); $msg = 'Đã cấp VIP cho đơn ' . $row->pay . ' (mã ' . $c . ').'; }
    } elseif ($do === 'regdel' && $id) {
        $wpdb->delete(hgs_vip_reg_table(), array('id' => $id));
        $msg = 'Đã xóa đăng ký.';
    } elseif ($do === 'reject' && $id) {
        $wpdb->update(hgs_vip_reg_table(), array('status' => 2), array('id' => $id));
        $msg = 'Đã bỏ đăng ký này.';
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

        $ot = hgs_vip_order_table();
        $bank = hgs_vip_bank();
        $sk = (string) get_option('hgs_vip_sepay_key', '');
        $ap = get_option('hgs_vip_autopay', '') === '1';
        $own = get_option('hgs_vip_bank', array());
        echo '<h2>Mua VIP tự động (quét QR, SePay xác nhận tiền)</h2>';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="background:#fff;border:1px solid #dcdcde;padding:12px 16px;max-width:900px">' . wp_nonce_field('hgs_vip', '_wpnonce', true, false)
            . '<input type="hidden" name="action" value="hgs_vip"><input type="hidden" name="do" value="sepay">'
            . '<p><label><input type="checkbox" name="autopay" value="1"' . checked($ap, true, false) . '> <b>Bật mua tự động trong app</b> (khách chọn gói, quét QR, tiền vào là VIP tự bật)</label></p>'
            . '<p>Tài khoản nhận tiền: ' . ($bank ? '<b>' . esc_html($bank['bank']) . ' · …' . esc_html(substr($bank['acc'], -4)) . ' · ' . esc_html($bank['name']) . '</b> <span class="description">(lấy từ ' . esc_html($bank['src']) . ')</span>' : '<b style="color:#d63638">chưa có</b>') . '</p>'
            . '<details' . ($bank ? '' : ' open') . '><summary>Dùng tài khoản khác cho VIP</summary><p>Ngân hàng (mã, VD: VCB, MB, TCB, ACB, 970436) <input name="bk" value="' . esc_attr(isset($own['bank']) ? $own['bank'] : '') . '" style="width:120px"> Số tài khoản <input name="ba" value="" placeholder="' . (isset($own['acc']) ? '…' . esc_attr(substr($own['acc'], -4)) : '') . '" style="width:180px"> Tên chủ TK <input name="bn" value="' . esc_attr(isset($own['name']) ? $own['name'] : '') . '" style="width:200px"> <label><input type="checkbox" name="bclear" value="1"> dùng lại tài khoản VietQR của web</label></p></details>'
            . ($bank ? '<p>Mã QR thử (10.000đ, nội dung HSV000000) để kiểm tra đúng tài khoản: <br><img src="' . esc_url('https://img.vietqr.io/image/' . rawurlencode(hgs_vip_bin($bank['bank'])) . '-' . rawurlencode($bank['acc']) . '-compact2.png?amount=10000&addInfo=HSV000000&accountName=' . rawurlencode($bank['name'])) . '" alt="QR thử" style="width:180px;border:1px solid #ddd;margin-top:6px"></p>' : '')
            . '<p>Đường dẫn Webhook cho SePay: <code>' . esc_html(rest_url('hgs-sub/v1/vip/sepay')) . '</code></p>'
            . '<p>API Key cho SePay (chọn kiểu xác thực "API Key"): ' . ($sk ? '<code>' . esc_html($sk) . '</code>' : '<i>bấm Lưu để tạo</i>') . ' <label><input type="checkbox" name="newkey" value="1"> tạo key mới</label></p>'
            . '<p class="description">SePay báo gần nhất: ' . esc_html(get_option('hgs_vip_sepay_last', 'chưa có')) . '</p>'
            . '<button class="button button-primary">Lưu</button></form>';
        $ords = $wpdb->get_results("SELECT * FROM $ot ORDER BY id DESC LIMIT 40");
        echo '<h3>Đơn mua VIP</h3><table class="widefat striped" style="margin-bottom:18px"><thead><tr><th>Thời gian</th><th>Nội dung CK</th><th>Gói</th><th>Số tiền</th><th>SĐT</th><th>Trạng thái</th><th></th></tr></thead><tbody>';
        if (!$ords) echo '<tr><td colspan="7">Chưa có đơn nào.</td></tr>';
        foreach ($ords as $x) {
            $st = (int) $x->status === 1 ? '<span style="color:#008a20">Đã trả, VIP ' . esc_html($x->code) . '</span>' : ((int) $x->status === 3 ? '<b style="color:#d63638">Chuyển thiếu (' . number_format($x->got, 0, ',', '.') . 'đ)</b>' : 'Chờ chuyển khoản');
            echo '<tr><td>' . esc_html(wp_date('d/m H:i', strtotime($x->created . ' UTC'))) . '</td><td><code>' . esc_html($x->pay) . '</code></td><td>' . esc_html($x->plan) . '</td><td>' . number_format($x->amount, 0, ',', '.') . 'đ</td><td>' . esc_html($x->phone) . '</td><td>' . $st . '</td><td>'
                . ((int) $x->status !== 1 ? $f('paid', $x->id, 'Đã nhận tiền, cấp VIP', '', 'Xác nhận đã nhận tiền đơn ' . $x->pay . '?') : '') . '</td></tr>';
        }
        echo '</tbody></table>';
        $rt = hgs_vip_reg_table();
        $regs = $wpdb->get_results("SELECT * FROM $rt ORDER BY status=0 DESC, id DESC LIMIT 60");
        echo '<h2>Khách đăng ký VIP</h2><p class="description">Khách bấm "Đăng ký VIP" trong app sẽ hiện ở đây. Gọi / nhắn Zalo xác nhận và nhận tiền, rồi bấm <b>Cấp mã</b>: VIP tự bật trên máy khách, không cần gửi mã.</p>';
        echo '<table class="widefat striped" style="margin-bottom:18px"><thead><tr><th>Thời gian</th><th>Khách</th><th>SĐT / Zalo</th><th>Gói</th><th>Ghi chú</th><th>Trạng thái</th><th></th></tr></thead><tbody>';
        if (!$regs) echo '<tr><td colspan="7">Chưa có đăng ký nào.</td></tr>';
        foreach ($regs as $g) {
            $st = (int) $g->status === 0 ? '<b style="color:#d63638">Chờ duyệt</b>' : ((int) $g->status === 1 ? '<span style="color:#008a20">Đã cấp ' . esc_html($g->code) . '</span>' : 'Đã bỏ');
            echo '<tr><td>' . esc_html(wp_date('d/m H:i', strtotime($g->created . ' UTC'))) . '</td><td>' . esc_html($g->name) . '</td>'
                . '<td><a href="tel:' . esc_attr($g->phone) . '">' . esc_html($g->phone) . '</a> · <a href="https://zalo.me/' . esc_attr($g->phone) . '" target="_blank" rel="noopener">Zalo</a></td>'
                . '<td>' . esc_html($g->plan) . ($g->price !== '' ? ' · ' . esc_html($g->price) : '') . '</td><td>' . esc_html($g->note) . '</td><td>' . $st . '</td><td>'
                . ((int) $g->status === 0 ? $f('approve', $g->id, 'Cấp mã', '<input type="number" name="days" value="' . (int) $g->days . '" min="1" style="width:64px"> ngày ') . $f('reject', $g->id, 'Bỏ', '', 'Bỏ đăng ký của ' . $g->name . '?') : $f('regdel', $g->id, 'Xóa', '', 'Xóa đăng ký của ' . $g->name . '?'))
                . '</td></tr>';
        }
        echo '</tbody></table>';

        $pl = hgs_vip_plans();
        while (count($pl) < 4) $pl[] = array('name' => '', 'days' => '', 'price' => '');
        echo '<h2>Gói VIP và giá (hiện trong app)</h2><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">' . wp_nonce_field('hgs_vip', '_wpnonce', true, false)
            . '<input type="hidden" name="action" value="hgs_vip"><input type="hidden" name="do" value="plans"><table class="widefat" style="max-width:640px"><thead><tr><th>Tên gói</th><th>Số ngày</th><th>Giá (để trống: shop báo giá qua Zalo)</th></tr></thead><tbody>';
        foreach ($pl as $i => $x) {
            echo '<tr><td><input name="pn[' . $i . ']" value="' . esc_attr($x['name']) . '" placeholder="VD: 1 tháng"></td><td><input type="number" name="pd[' . $i . ']" value="' . esc_attr($x['days']) . '" style="width:80px"></td><td><input name="pp[' . $i . ']" value="' . esc_attr($x['price']) . '" placeholder="VD: 49.000đ"></td></tr>';
        }
        echo '</tbody></table><p>Hướng dẫn thanh toán hiện cho khách sau khi đăng ký (không bắt buộc):<br><textarea name="pay" rows="3" style="width:640px" placeholder="VD: Shop sẽ gọi xác nhận. Chuyển khoản: ...">' . esc_textarea(get_option('hgs_vip_pay', '')) . '</textarea></p>'
            . '<p>Email nhận báo đăng ký mới: <input type="email" name="mail" value="' . esc_attr(get_option('hgs_vip_mail', '')) . '" placeholder="' . esc_attr(get_option('admin_email')) . '" style="width:300px"></p>'
            . '<button class="button button-primary">Lưu gói và giá</button></form>';

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
