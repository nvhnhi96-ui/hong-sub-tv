'use strict';
/* Online voice that needs no key and no download: the Google voice of Google Translate (female, Vietnamese).
   Returns MP3. Used by main.js for the voice id "gg:vi". */

const GG_VOICES = [{ id: 'gg:vi', name: 'Google (nữ, online)', gender: 'female' }];

/* at most ~200 characters per request, so long lines go in pieces (MP3 pieces join end to end) */
function chunks(t, max) {
  const out = []; let s = String(t).replace(/\s+/g, ' ').trim();
  while (s.length > max) {
    let cut = Math.max(s.lastIndexOf('. ', max), s.lastIndexOf(', ', max), s.lastIndexOf('! ', max), s.lastIndexOf('? ', max));
    if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(s.slice(0, cut + 1).trim()); s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}
async function gg(text, fetcher) {
  const bufs = [];
  for (const c of chunks(text, 190)) {
    const u = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=' + encodeURIComponent(c);
    const r = await fetcher(u, {});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    bufs.push(Buffer.from(await r.arrayBuffer()));
  }
  const mp3 = Buffer.concat(bufs);
  if (mp3.length < 200) throw new Error('empty audio');
  return mp3;
}

module.exports = { GG_VOICES, gg, chunks };
