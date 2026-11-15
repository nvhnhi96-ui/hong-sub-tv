
// Hong Sub: kho dich chung. Moi cau thoai da dich duoc nho theo tung game,
// nguoi choi sau gap lai cau do thi hien ngay, khong phai cho AI dich lai.
if (!function_exists('hgs_tm_table')) {
    function hgs_tm_table() {
        global $wpdb;
        $t = $wpdb->prefix . 'hgs_tm';
        if (get_option('hgs_tm_db') !== '1') {
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
            $c = $wpdb->get_charset_collate();
            dbDelta("CREATE TABLE $t (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  g varchar(80) NOT NULL,
  gn varchar(120) NOT NULL DEFAULT '',
  k char(40) NOT NULL,
  kind char(1) NOT NULL DEFAULT 's',
  en text NOT NULL,
  vi text NOT NULL,
  who varchar(60) NOT NULL DEFAULT '',
  gd varchar(8) NOT NULL DEFAULT '',
  q tinyint(3) unsigned NOT NULL DEFAULT 1,
  n int(10) unsigned NOT NULL DEFAULT 1,
  t datetime NOT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY k (k),
  KEY g (g,id)
) $c;");
            update_option('hgs_tm_db', '1', false);
        }
        return $t;
    }
    function hgs_tm_game($s) {
        $s = remove_accents(mb_strtolower(trim((string) $s), 'UTF-8'));
        $s = preg_replace('/[^a-z0-9]+/', ' ', $s);
        return substr(trim($s), 0, 80);
    }
    function hgs_tm_norm($s) {
        return preg_replace('/[^\p{L}\p{N}]+/u', '', mb_strtolower((string) $s, 'UTF-8'));
    }
    function hgs_tm_clean($s, $max) {
        $s = trim(wp_strip_all_tags(wp_check_invalid_utf8((string) $s)));
        return mb_substr(preg_replace('/[ \t]+/u', ' ', $s), 0, $max);
    }
    function hgs_tm_add($req) {
        global $wpdb;
        $t  = hgs_tm_table();
        $gn = hgs_tm_clean($req->get_param('game'), 120);
        $g  = hgs_tm_game($gn);
        $items = $req->get_param('items');
        if (strlen($g) < 2 || !is_array($items)) return new WP_Error('bad', 'bad request', array('status' => 400));
        $items = array_slice($items, 0, 25);
        $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
        $rk = 'hgs_tm_rl_' . md5($ip);
        $used = (int) get_transient($rk);
        if ($used > 600) return new WP_Error('busy', 'too many', array('status' => 429));
        $now = current_time('mysql', 1);
        $ok = 0;
        foreach ($items as $it) {
            if (!is_array($it)) continue;
            $en = hgs_tm_clean(isset($it['en']) ? $it['en'] : '', 500);
            $vi = hgs_tm_clean(isset($it['vi']) ? $it['vi'] : '', 800);
            $nm = hgs_tm_norm($en);
            if (mb_strlen($nm) < 2 || $vi === '') continue;
            $kind = (isset($it['kind']) && $it['kind'] === 'z') ? 'z' : 's';
            $who  = hgs_tm_clean(isset($it['who']) ? $it['who'] : '', 60);
            $gd   = (isset($it['gd']) && in_array($it['gd'], array('male', 'female'), true)) ? $it['gd'] : '';
            $q    = (isset($it['q']) && (int) $it['q'] === 2) ? 2 : 1;
            $k    = sha1($g . '|' . $kind . '|' . $nm);
            $wpdb->query($wpdb->prepare(
                "INSERT INTO $t (g,gn,k,kind,en,vi,who,gd,q,n,t) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%d,1,%s)
                 ON DUPLICATE KEY UPDATE n=n+1, vi=IF(VALUES(q)>q,VALUES(vi),vi), who=IF(VALUES(q)>q,VALUES(who),who), gd=IF(VALUES(q)>q AND VALUES(gd)<>'',VALUES(gd),gd), q=GREATEST(q,VALUES(q))",
                $g, $gn, $k, $kind, $en, $vi, $who, $gd, $q, $now));
            $ok++;
        }
        set_transient($rk, $used + max(1, $ok), 600);
        return array('ok' => true, 'saved' => $ok);
    }
    function hgs_tm_pack($req) {
        global $wpdb;
        $t = hgs_tm_table();
        $g = hgs_tm_game($req->get_param('game'));
        if (strlen($g) < 2) return array('lines' => array(), 'last' => 0, 'more' => false, 'total' => 0);
        $since = max(0, (int) $req->get_param('since'));
        $rows = $wpdb->get_results($wpdb->prepare("SELECT id,kind,en,vi,who,gd FROM $t WHERE g=%s AND id>%d ORDER BY id LIMIT 3000", $g, $since), ARRAY_N);
        $last = $since; $lines = array();
        foreach ((array) $rows as $r) { $last = (int) $r[0]; $lines[] = array($r[1], $r[2], $r[3], $r[4], $r[5]); }
        $out = array('lines' => $lines, 'last' => $last, 'more' => count($lines) === 3000);
        if ($since === 0) $out['total'] = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $t WHERE g=%s", $g));
        return $out;
    }
    function hgs_tm_games() {
        global $wpdb;
        $c = get_transient('hgs_tm_games2');
        if ($c !== false) return $c;
        $t = hgs_tm_table();
        $rows = $wpdb->get_results("SELECT g, MAX(gn) AS gn, COUNT(*) AS n FROM $t WHERE kind='s' AND g NOT LIKE 'zz %' GROUP BY g ORDER BY n DESC LIMIT 60", ARRAY_A);
        $out = array();
        foreach ((array) $rows as $r) $out[] = array('g' => $r['g'], 'name' => $r['gn'], 'n' => (int) $r['n']);
        set_transient('hgs_tm_games2', $out, 600);
        return $out;
    }
}
add_action('rest_api_init', function () {
    register_rest_route('hgs-sub/v1', '/tm/add', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'hgs_tm_add'));
    register_rest_route('hgs-sub/v1', '/tm/pack', array('methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => 'hgs_tm_pack'));
    register_rest_route('hgs-sub/v1', '/tm/games', array('methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => 'hgs_tm_games2'));
});

// Hong Sub: nap ban dich co san (vd ban Viet hoa cua mot game) vao kho dich chung. Chi quan tri vien.
if (!function_exists('hgs_tm_import')) {
    function hgs_tm_import($req) {
        global $wpdb;
        $t  = hgs_tm_table();
        $gn = hgs_tm_clean($req->get_param('game'), 120);
        $g  = hgs_tm_game($gn);
        $items = $req->get_param('items');
        if (strlen($g) < 2 || !is_array($items)) return new WP_Error('bad', 'bad request', array('status' => 400));
        $now = current_time('mysql', 1);
        $ok = 0;
        foreach (array_slice($items, 0, 1000) as $it) {
            if (!is_array($it)) continue;
            $en = hgs_tm_clean(isset($it['en']) ? $it['en'] : '', 500);
            $vi = hgs_tm_clean(isset($it['vi']) ? $it['vi'] : '', 800);
            $nm = hgs_tm_norm($en);
            if (mb_strlen($nm) < 2 || $vi === '') continue;
            $kind = (isset($it['kind']) && $it['kind'] === 'z') ? 'z' : 's';
            $k = sha1($g . '|' . $kind . '|' . $nm);
            $wpdb->query($wpdb->prepare(
                "INSERT INTO $t (g,gn,k,kind,en,vi,who,gd,q,n,t) VALUES (%s,%s,%s,%s,%s,%s,'','',3,1,%s)
                 ON DUPLICATE KEY UPDATE vi=VALUES(vi), q=3, n=n+1",
                $g, $gn, $k, $kind, $en, $vi, $now));
            $ok++;
        }
        delete_transient('hgs_tm_games2');
        return array('ok' => true, 'saved' => $ok);
    }
}
add_action('rest_api_init', function () {
    register_rest_route('hgs-sub/v1', '/tm/import', array('methods' => 'POST', 'callback' => 'hgs_tm_import',
        'permission_callback' => function () { return current_user_can('manage_options'); }));
});
