
// Hong Sub: kho dich chung. Moi cau thoai da dich duoc nho theo tung game,
// nguoi choi sau gap lai cau do thi hien ngay, khong phai cho AI dich lai.
if (!function_exists('hgs_tm_table')) {
    function hgs_tm_table() {
        global $wpdb;
        $t = $wpdb->prefix . 'hgs_tm';
        if (get_option('hgs_tm_db') !== '2') {
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
  std tinyint(1) unsigned NOT NULL DEFAULT 0,
  n int(10) unsigned NOT NULL DEFAULT 1,
  t datetime NOT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY k (k),
  KEY g (g,id)
) $c;");
            update_option('hgs_tm_db', '2', false);
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
            $fx   = ($q === 2 && !empty($it['fx'])) ? 1 : 0;   // a stored line checked and fixed by AI: replaces a line of the same level (not an imported one)
            // std: translated with the GAME's own settings (its style, its character notes, its rules), not with one
            // player's personal ones. A player who uses the game's settings shows such a line as it is, with no AI.
            $std  = ($q === 2 && !empty($it['std'])) ? 1 : 0;
            $k    = sha1($g . '|' . $kind . '|' . $nm);
            $wpdb->query($wpdb->prepare(
                "INSERT INTO $t (g,gn,k,kind,en,vi,who,gd,q,std,n,t) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%d,%d,1,%s)
                 ON DUPLICATE KEY UPDATE n=n+1, std=IF(VALUES(q)>q OR (%d=1 AND q<=2),VALUES(std),std), vi=IF(VALUES(q)>q OR (%d=1 AND q<=2),VALUES(vi),vi), who=IF(VALUES(q)>q,VALUES(who),who), gd=IF(VALUES(q)>q AND VALUES(gd)<>'',VALUES(gd),gd), q=GREATEST(q,VALUES(q))",
                $g, $gn, $k, $kind, $en, $vi, $who, $gd, $q, $std, $now, $fx, $fx));
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
        $rows = $wpdb->get_results($wpdb->prepare("SELECT id,kind,en,vi,who,gd,std FROM $t WHERE g=%s AND id>%d ORDER BY id LIMIT 3000", $g, $since), ARRAY_N);
        $last = $since; $lines = array();
        foreach ((array) $rows as $r) { $last = (int) $r[0]; $lines[] = array($r[1], $r[2], $r[3], $r[4], $r[5], (int) $r[6]); }
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
    register_rest_route('hgs-sub/v1', '/tm/games', array('methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => 'hgs_tm_games'));
});

// Hong Sub: nap ban dich co san (vd ban Viet hoa cua mot game) vao kho dich chung. Chi quan tri vien.
if (!function_exists('hgs_tm_import')) {
    function hgs_tm_markall($req) {
    global $wpdb; $t = hgs_tm_table();
    $g   = hgs_tm_game((string) $req->get_param('game'));
    $std = $req->get_param('std') === '0' ? 0 : 1;
    if ($g === '') return new WP_Error('bad', 'thieu ten game', array('status' => 400));
    $n = $wpdb->query($wpdb->prepare("UPDATE $t SET std=%d WHERE g=%s AND kind='s' AND q<=2 AND std<>%d", $std, $g, $std));
    return array('ok' => true, 'game' => $g, 'std' => $std, 'updated' => (int) $n,
                 'now' => (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $t WHERE g=%s AND kind='s' AND std=1", $g)));
}
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

    // Danh dau ca kho cua mot game la "dich theo cai dat goc cua game" (std=1), sau khi cong cu "Dich lai toan bo"
    // da duyet het cau thoai cua game do theo luat hien tai. Chi cau thoai (kind='s'), khong dung toi chu tren man
    // hinh (kind='z') va khong dung toi cau nhap san (q=3). Chi quan tri vien chay duoc. Bo dau: std=0.
    register_rest_route('hgs-sub/v1', '/tm/markall', array('methods' => 'POST', 'callback' => 'hgs_tm_markall',
        'permission_callback' => function () { return current_user_can('manage_options'); }));
});

// Hong Sub: duong dan ngan de go tren TV (Downloader tren Android TV, trinh duyet TV)
add_action('template_redirect', function () {
    $p = trim(strtolower(parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '', PHP_URL_PATH)), '/');
    $rel = 'https://github.com/nvhnhi96-ui/hong-sub-tv/releases/latest/download/';
    $go = array(
        'tv'      => $rel . 'hong-sub-tv.apk',
        'tvapp'   => $rel . 'hong-sub-tv.apk',
        'samsung' => $rel . 'hong-sub-samsung.wgt',
        'tvweb'   => home_url('/lg'),
    );
    if (isset($go[$p])) { wp_redirect($go[$p], 302); exit; }
}, 0);
