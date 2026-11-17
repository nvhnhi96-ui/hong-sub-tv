# hsrp — Remote Play core of the Hóng Sub phone apps

PS5 / PS4 straight into the Hóng Sub app on Android phones and iPhone, without Sony's PS Remote Play app.
Built on [chiaki-ng](https://github.com/streetpea/chiaki-ng)'s chiaki-lib (GNU AGPL-3.0); this folder is AGPL-3.0 too.

- `hsrp.c` — WebSocket (and, for the iPhone app, the page itself) on 127.0.0.1 for the Hóng Sub page:
  finding / waking the console, pairing, the picture (H.264), sound (Opus) and controller input.
- `hsrp_jni.c` — Android entry point (`store.honggame.hongsub.Hsrp`).
- `stubs.c`, `shim/` — the phone build leaves out PSN remote connection (holepunch), which needs curl, json-c,
  miniupnpc and libevent.

Build: see `phone/build.gradle` (Android) and `ios/build-rp.sh` (iPhone). Test on a computer:
`cmake -S rp/mobile -B build -DHSRP_TEST=ON -DCHIAKI_DIR=<chiaki-ng>` then `build/hsrp-test 47123 <token> [web root]`.
