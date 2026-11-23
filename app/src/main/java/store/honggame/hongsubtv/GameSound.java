package store.honggame.hongsubtv;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaFormat;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * The game's sound while the PS5 plays through Hóng Sub on the computer. The PS turns its own sound on the TV off
 * during Remote Play, so Hóng Sub on the computer passes the PS's sound on: Opus packets (48 kHz, 10 ms each), two to
 * a datagram on UDP 8769: 'H', channels, sequence (2 bytes), then for each packet its length (2 bytes) and its bytes.
 * They are decoded here and played on the TV's speakers with as little delay as the TV allows.
 */
final class GameSound {
    static final int PORT = 8769;
    /** how long the game's sound takes from arriving here to coming out of the speaker (ms), 0 when not playing:
        the computer plays its own copy that much later, so the two are heard together */
    static volatile int latencyMs = 0;
    /** the same, measured where it counts: when a packet arrives, how much sound is still ahead of it (the store here
        plus what the speaker's own buffer holds), the highest of the last ~2 s (the packets that came on time; one
        held back by Wi-Fi finds less ahead of it), plus the TV's output time. latencyMs is a sample taken every
        half second that assumes a full speaker buffer: it jumps ~100 ms with every burst of Wi-Fi, and the computer
        following it was heard as an echo that comes and goes. 0 when not playing. */
    static volatile int latencyMs2 = 0;
    private volatile long written = 0;       // frames given to the speaker since it was opened
    private volatile int afMs = 40;          // the TV's own output time behind the speaker buffer
    private int winCur = 0, winPrev = 0;
    private long winAt = 0;
    private static java.lang.reflect.Method trackLat;
    static { try { trackLat = AudioTrack.class.getMethod("getLatency"); } catch (Throwable e) { trackLat = null; } }
    private volatile boolean on;
    private DatagramSocket sock;
    private MediaCodec dec;
    private AudioTrack track;
    private int chans = 0;
    private long pts = 0;
    private volatile long lastAt = 0;
    private int lastSeq = -1;
    // a small store of decoded sound between the network and the speaker: the network brings packets in bursts
    // (Wi-Fi), the speaker needs them evenly. Playing starts when ~0.12 s is stored; after a gap it fills up again
    // first (a short silence instead of crackling); more than ~0.35 s stored and the oldest is dropped (no growing delay).
    private final java.util.ArrayDeque<byte[]> pcm = new java.util.ArrayDeque<>();
    private int pcmBytes = 0;
    private Thread player;
    private long latAt = 0;

    void start() {
        if (on) return;
        on = true;
        Thread t = new Thread(this::loop, "hongsub-sound");
        t.setDaemon(true);
        t.start();
        Thread w = new Thread(this::idle, "hongsub-sound-idle");   // nothing for a while (the PS is off): let go of the speaker
        w.setDaemon(true);
        w.start();
    }

    void stop() {
        on = false;
        try { if (sock != null) sock.close(); } catch (Exception ignored) { }
        close();
    }

    private void idle() {
        while (on) {
            try { Thread.sleep(2000); } catch (InterruptedException e) { return; }
            if (lastAt != 0 && System.currentTimeMillis() - lastAt > 5000) { synchronized (this) { close(); } lastAt = 0; }
        }
    }

    private void loop() {
        byte[] buf = new byte[4096];
        while (on) {
            try {
                sock = new DatagramSocket(null);
                sock.setReuseAddress(true);
                sock.bind(new InetSocketAddress(PORT));
                while (on) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    sock.receive(p);
                    handle(buf, p.getLength());
                }
            } catch (Exception e) {
                try { if (sock != null) sock.close(); } catch (Exception ignored) { }
                if (on) try { Thread.sleep(1500); } catch (InterruptedException ie) { return; }
            }
        }
    }

    private synchronized void handle(byte[] b, int n) {
        if (n >= 6 && b[0] == 'I') { handleI(b, n); return; }
        if (n < 6 || b[0] != 'H') return;
        int ch = b[1] == 1 ? 1 : 2;
        int seq = ((b[2] & 255) << 8) | (b[3] & 255);
        if (lastSeq >= 0) {
            int d = (seq - lastSeq) & 0xFFFF;
            if (d == 0 || d > 0x8000) return;   // the same datagram twice, or an old one arriving late: played already
        }
        lastSeq = seq;
        if (dec == null || ch != chans) { close(); if (!open(ch)) return; }
        lastAt = System.currentTimeMillis();
        int o = 4;
        while (o + 2 <= n) {
            int len = ((b[o] & 255) << 8) | (b[o + 1] & 255); o += 2;
            if (len <= 0 || o + len > n) break;
            feed(b, o, len); o += len;
        }
        drain();
        mark();
    }

    /* 'I': every packet has its own number, and each datagram also carries the packets of the one before it, so a
       datagram lost on Wi-Fi costs nothing: 'I', channels, then per packet: number (2 bytes), length (2), bytes */
    private int lastPkt = -1;
    private void handleI(byte[] b, int n) {
        int ch = b[1] == 1 ? 1 : 2;
        if (dec == null || ch != chans) { close(); if (!open(ch)) return; }
        lastAt = System.currentTimeMillis();
        int o = 2;
        while (o + 4 <= n) {
            int seq = ((b[o] & 255) << 8) | (b[o + 1] & 255), len = ((b[o + 2] & 255) << 8) | (b[o + 3] & 255); o += 4;
            if (len <= 0 || o + len > n) break;
            int d = lastPkt < 0 ? 1 : (seq - lastPkt) & 0xFFFF;
            if (d != 0 && d < 0x8000) {   // new: played in order (a repeat or an old one is skipped)
                if (lastPkt >= 0 && d > 1 && d < 6) pts += 10_000L * (d - 1);
                feed(b, o, len); lastPkt = seq;
            }
            o += len;
        }
        drain();
        mark();
    }

    /* how long the newest packet waits before it is heard (ms): the store + the speaker's buffer + the TV's output */
    private void mark() {
        try {
            AudioTrack tr = track;
            int ch = chans;
            if (tr == null || ch == 0) return;
            int stored; synchronized (pcm) { stored = pcmBytes; }
            long head = tr.getPlaybackHeadPosition() & 0xFFFFFFFFL;
            long inTrack = Math.max(0, written - head);
            int level = (int) (stored * 1000L / (48000L * 2 * ch) + inTrack * 1000L / 48000) - 10;   // to the START of the newest packet (10 ms)
            if (level < 0) level = 0;
            if (level > 1500) return;
            long now = System.currentTimeMillis();
            if (now - winAt > 1000) { winPrev = winCur; winCur = 0; winAt = now; }
            if (level > winCur) winCur = level;
            if (tr.getPlayState() == AudioTrack.PLAYSTATE_PLAYING) latencyMs2 = Math.max(winCur, winPrev) + afMs;
        } catch (Throwable ignored) { }
    }

    private boolean open(int ch) {
        try {
            MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48000, ch);
            // OpusHead: version 1, channels, pre-skip 0, 48 kHz, gain 0, mapping family 0
            ByteBuffer head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
            head.put("OpusHead".getBytes("US-ASCII")).put((byte) 1).put((byte) ch).putShort((short) 0).putInt(48000).putShort((short) 0).put((byte) 0);
            head.flip();
            f.setByteBuffer("csd-0", head);
            f.setByteBuffer("csd-1", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(0, 0L));
            f.setByteBuffer("csd-2", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(0, 80_000_000L));
            dec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            dec.configure(f, null, null, 0);
            dec.start();
            int cm = ch == 1 ? AudioFormat.CHANNEL_OUT_MONO : AudioFormat.CHANNEL_OUT_STEREO;
            int min = AudioTrack.getMinBufferSize(48000, cm, AudioFormat.ENCODING_PCM_16BIT);
            track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                    .setAudioFormat(new AudioFormat.Builder().setSampleRate(48000).setChannelMask(cm).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(Math.max(min * 2, 48000 * 2 * ch / 8))   // about 0.12 s in the speaker itself
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
            chans = ch; pts = 0; written = 0; winCur = 0; winPrev = 0; winAt = 0; latencyMs2 = 0;
            synchronized (pcm) { pcm.clear(); pcmBytes = 0; }
            final AudioTrack tr = track;
            final int bps = 48000 * 2 * ch;   // bytes a second
            player = new Thread(() -> play(tr, bps), "hongsub-sound-play");
            player.setDaemon(true);
            player.start();
            return true;
        } catch (Throwable e) {
            close();
            return false;
        }
    }

    private void feed(byte[] b, int o, int len) {
        try {
            int i = dec.dequeueInputBuffer(5000);
            if (i < 0) return;   // the decoder is behind: this packet is dropped
            ByteBuffer in = dec.getInputBuffer(i);
            if (in == null) return;
            in.clear(); in.put(b, o, len);
            dec.queueInputBuffer(i, 0, len, pts, 0);
            pts += 10_000;
        } catch (Throwable e) { close(); }
    }

    private void drain() {
        try {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int k;
            while ((k = dec.dequeueOutputBuffer(info, 0)) != MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (k < 0) continue;   // format or buffers changed
                ByteBuffer out = dec.getOutputBuffer(k);
                if (out != null && info.size > 0 && track != null) {
                    byte[] chunk = new byte[info.size];
                    out.position(info.offset); out.limit(info.offset + info.size); out.get(chunk);
                    synchronized (pcm) {
                        pcm.addLast(chunk); pcmBytes += chunk.length;
                        int max = 48000 * 2 * chans * 35 / 100, keep = 48000 * 2 * chans * 15 / 100;
                        if (pcmBytes > max) while (pcmBytes > keep && pcm.size() > 1) pcmBytes -= pcm.pollFirst().length;
                        pcm.notifyAll();
                    }
                }
                dec.releaseOutputBuffer(k, false);
            }
        } catch (Throwable e) { close(); }
    }

    /* the speaker side: evenly, from the store, waiting for ~0.12 s of sound before starting or after a gap */
    private void play(AudioTrack tr, int bps) {
        int start = bps * 12 / 100;
        boolean filling = true;
        try {
            while (on && tr == track) {
                byte[] chunk;
                synchronized (pcm) {
                    if (filling) {
                        while (on && tr == track && pcmBytes < start) pcm.wait(200);
                        if (!(on && tr == track)) break;
                        filling = false;
                        if (tr.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) tr.play();
                    }
                    if (pcm.isEmpty()) { pcm.wait(60); if (pcm.isEmpty()) { filling = true; continue; } }   // a gap: fill up again
                    chunk = pcm.pollFirst(); pcmBytes -= chunk.length;
                }
                int wr = tr.write(chunk, 0, chunk.length);   // waits for room in the speaker: keeps the pace even
                if (wr > 0) written += wr / (bps / 48000);
                long now = System.currentTimeMillis();
                if (now - latAt > 500) {
                    latAt = now;
                    int dev = 0;
                    try { if (trackLat != null) dev = (Integer) trackLat.invoke(tr); } catch (Throwable ignored) { dev = 0; }
                    int cap = (int) (tr.getBufferSizeInFrames() * 1000L / 48000);
                    afMs = (dev > 0 && dev <= 1500) ? Math.max(0, Math.min(400, dev - cap)) : 40;   // getLatency() = the speaker buffer + the TV's output time
                    if (dev <= 0 || dev > 1500) dev = cap + 40;
                    int stored; synchronized (pcm) { stored = pcmBytes; }
                    latencyMs = stored * 1000 / bps + dev;
                }
            }
        } catch (Throwable ignored) { }
    }

    private void close() {
        try { if (dec != null) { dec.stop(); dec.release(); } } catch (Throwable ignored) { }
        dec = null;
        try { if (track != null) { track.pause(); track.flush(); track.release(); } } catch (Throwable ignored) { }
        track = null; chans = 0; lastSeq = -1; lastPkt = -1; latencyMs = 0; latencyMs2 = 0;
        synchronized (pcm) { pcm.clear(); pcmBytes = 0; pcm.notifyAll(); }
    }
}
