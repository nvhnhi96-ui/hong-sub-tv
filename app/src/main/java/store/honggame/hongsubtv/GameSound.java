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
    private volatile boolean on;
    private DatagramSocket sock;
    private MediaCodec dec;
    private AudioTrack track;
    private int chans = 0;
    private long pts = 0;
    private volatile long lastAt = 0;

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
        if (n < 6 || b[0] != 'H') return;
        int ch = b[1] == 1 ? 1 : 2;
        if (dec == null || ch != chans) { close(); if (!open(ch)) return; }
        lastAt = System.currentTimeMillis();
        int o = 4;
        while (o + 2 <= n) {
            int len = ((b[o] & 255) << 8) | (b[o + 1] & 255); o += 2;
            if (len <= 0 || o + len > n) break;
            feed(b, o, len); o += len;
        }
        drain();
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
                    .setBufferSizeInBytes(Math.max(min, 48000 * 2 * ch / 10))   // about 0.1 s
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
            track.play();
            chans = ch; pts = 0;
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
                    out.position(info.offset); out.limit(info.offset + info.size);
                    track.write(out, info.size, AudioTrack.WRITE_NON_BLOCKING);   // never waits: late sound is dropped, not delayed
                }
                dec.releaseOutputBuffer(k, false);
            }
        } catch (Throwable e) { close(); }
    }

    private void close() {
        try { if (dec != null) { dec.stop(); dec.release(); } } catch (Throwable ignored) { }
        dec = null;
        try { if (track != null) { track.pause(); track.flush(); track.release(); } } catch (Throwable ignored) { }
        track = null; chans = 0;
    }
}
