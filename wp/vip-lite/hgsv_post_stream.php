/* goi AI va gui chu dan ve app trong luc AI dang viet (25/11/2026: "AI dich toi dau hien va doc toi do").
   Loi tu AI (khong phai 200) thi tra ve nguyen van nhu hgsv_post, chua gui gi cho app. Xong thi tra ve nhu mot cau
   tra loi binh thuong (content + usage) de phan sau giu nguyen. */
function hgsv_post_stream($key, $b) {
  $b['stream'] = true;
  $st = 0; $raw = ''; $buf = ''; $txt = ''; $u = array(); $sent = 0; $evErr = '';
  $c = curl_init('https://api.anthropic.com/v1/messages');
  curl_setopt_array($c, array(CURLOPT_POST => true, CURLOPT_TIMEOUT => 25, CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_HTTPHEADER => array('x-api-key: ' . $key, 'anthropic-version: 2023-06-01', 'content-type: application/json'),
    CURLOPT_POSTFIELDS => json_encode($b, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
    CURLOPT_WRITEFUNCTION => function ($ch, $data) use (&$st, &$raw, &$buf, &$txt, &$u, &$sent, &$evErr) {
      if (!$st) $st = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
      if ($st !== 200) { $raw .= $data; return strlen($data); }
      $buf .= $data;
      while (($p = strpos($buf, "\n")) !== false) {
        $ln = rtrim(substr($buf, 0, $p), "\r"); $buf = substr($buf, $p + 1);
        if (strncmp($ln, 'data:', 5) !== 0) continue;
        $e = json_decode(trim(substr($ln, 5)), true);
        if (!is_array($e) || !isset($e['type'])) continue;
        if ($e['type'] === 'message_start' && isset($e['message']['usage']) && is_array($e['message']['usage'])) $u = array_merge($u, $e['message']['usage']);
        elseif ($e['type'] === 'message_delta' && isset($e['usage']) && is_array($e['usage'])) $u = array_merge($u, $e['usage']);
        elseif ($e['type'] === 'error') $evErr = isset($e['error']['message']) ? (string) $e['error']['message'] : 'error';
        elseif ($e['type'] === 'content_block_delta' && isset($e['delta']['type']) && $e['delta']['type'] === 'text_delta') {
          $d = (string) $e['delta']['text']; $txt .= $d;
          if (!$sent) {
            $sent = 1; $GLOBALS['hgsv_sse'] = true;
            header('Content-Type: text/event-stream; charset=utf-8'); header('X-Accel-Buffering: no'); header('Cache-Control: no-cache, no-transform');
            @ini_set('zlib.output_compression', '0'); while (ob_get_level()) @ob_end_flush();
            echo ': ' . str_repeat(' ', 4096) . "\n\n";
          }
          echo 'data: ' . json_encode(array('d' => $d), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n"; @flush();
        }
      }
      return strlen($data);
    }));
  $ok = curl_exec($c);
  if (!$st) $st = (int) curl_getinfo($c, CURLINFO_RESPONSE_CODE);
  curl_close($c);
  if ($st !== 200) return array($ok === false && $raw === '', $st, $raw);
  if ($txt === '') return array($evErr === '' && $ok === false, $evErr !== '' ? 529 : 502, json_encode(array('error' => array('message' => $evErr !== '' ? $evErr : 'empty'))));
  return array(false, 200, json_encode(array('content' => array(array('type' => 'text', 'text' => $txt)), 'usage' => $u), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}
